/**
 * EBS volume management for the EC2 db-host.
 * Uses spawnSync/execFileSync for AWS CLI and system commands (no shell injection risk).
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, appendFileSync } from 'fs';

function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.error}`);
    }
    return result.stdout.trim();
}

/**
 * Get EC2 instance metadata via IMDSv2.
 * @returns {{ instance_id: string, az: string, region: string }}
 */
export function get_instance_metadata() {
    const token = run('curl', [
        '-s', '-X', 'PUT',
        'http://169.254.169.254/latest/api/token',
        '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 300',
    ]);

    const doc = run('curl', [
        '-s',
        '-H', `X-aws-ec2-metadata-token: ${token}`,
        'http://169.254.169.254/latest/dynamic/instance-identity/document',
    ]);

    const identity = JSON.parse(doc);
    return {
        instance_id: identity.instanceId,
        az: identity.availabilityZone,
        region: identity.region,
    };
}

/**
 * Create an EBS volume with db-host tags.
 * @param {{ name: string, size: number, az: string, region: string, env_name?: string }} config
 * @returns {string} volume_id
 */
export function create_volume({ name, size, az, region, env_name }) {
    const tags = [
        { Key: 'Name', Value: `db-host-${name}` },
        { Key: 'ManagedBy', Value: 'db-host' },
        { Key: 'ServiceName', Value: name },
        { Key: 'MountPath', Value: `/mnt/data/${name}` },
    ];
    if (env_name) tags.push({ Key: 'Environment', Value: env_name });

    const tag_spec = JSON.stringify([{
        ResourceType: 'volume',
        Tags: tags,
    }]);

    const result = JSON.parse(run('aws', [
        'ec2', 'create-volume',
        '--availability-zone', az,
        '--size', String(size),
        '--volume-type', 'gp3',
        '--tag-specifications', tag_spec,
        '--region', region,
        '--output', 'json',
    ]));

    const volume_id = result.VolumeId;
    console.log(`Created volume ${volume_id} (${size}GB) in ${az}`);

    run('aws', [
        'ec2', 'wait', 'volume-available',
        '--volume-ids', volume_id,
        '--region', region,
    ], { timeout: 120000 });
    console.log(`Volume ${volume_id} is available`);

    return volume_id;
}

/**
 * Attach an EBS volume, format if new, mount, and add fstab entry.
 * @param {{ volume_id: string, mount_path: string, instance_id: string, region: string }} config
 */
export function attach_and_mount({ volume_id, mount_path, instance_id, region }) {
    // Find next available device letter (f through p)
    const attached = JSON.parse(run('aws', [
        'ec2', 'describe-instances',
        '--instance-ids', instance_id,
        '--query', 'Reservations[0].Instances[0].BlockDeviceMappings[].DeviceName',
        '--output', 'json',
        '--region', region,
    ]));
    const used_letters = new Set(attached.map(d => d.slice(-1)));
    let device_letter = '';
    for (const ch of 'fghijklmnop') {
        if (!used_letters.has(ch)) { device_letter = ch; break; }
    }
    if (!device_letter) throw new Error('No available device letters for EBS attachment');
    const device = `/dev/sd${device_letter}`;

    run('aws', [
        'ec2', 'attach-volume',
        '--volume-id', volume_id,
        '--instance-id', instance_id,
        '--device', device,
        '--region', region,
    ]);
    console.log(`Attaching ${volume_id} to ${instance_id} as ${device}`);

    run('aws', [
        'ec2', 'wait', 'volume-in-use',
        '--volume-ids', volume_id,
        '--region', region,
    ], { timeout: 120000 });

    // NVMe serial is the volume ID with hyphens removed (sed 's/-//g')
    const nvme_serial = volume_id.replace(/-/g, '');

    // Wait for NVMe device to appear and find it by serial
    let actual_device = '';
    for (let i = 0; i < 30; i++) {
        try {
            const lsblk = run('lsblk', ['-o', 'NAME,SERIAL', '-rn']);
            for (const line of lsblk.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2 && parts[1] === nvme_serial) {
                    actual_device = `/dev/${parts[0]}`;
                    break;
                }
            }
            if (actual_device) break;
        } catch { /* device not yet visible */ }
        spawnSync('sleep', ['1']);
    }

    if (!actual_device) throw new Error(`Could not find NVMe device for volume ${volume_id}`);
    console.log(`Found device: ${actual_device}`);

    // Check if device has a filesystem; format if not
    const blkid_check = spawnSync('blkid', [actual_device], { encoding: 'utf8', stdio: 'pipe' });
    if (blkid_check.status !== 0) {
        console.log('Formatting new volume with ext4');
        run('mkfs.ext4', ['-m', '0', actual_device]);
    } else {
        console.log('Device already formatted');
    }

    // Mount
    mkdirSync(mount_path, { recursive: true });
    run('mount', [actual_device, mount_path]);
    console.log(`Mounted ${actual_device} at ${mount_path}`);

    // Add UUID-based fstab entry if not already present
    const uuid = run('blkid', ['-s', 'UUID', '-o', 'value', actual_device]);
    const fstab = readFileSync('/etc/fstab', 'utf8');
    if (!fstab.includes(uuid)) {
        const entry = `UUID=${uuid} ${mount_path} ext4 defaults,nofail 0 2\n`;
        appendFileSync('/etc/fstab', entry);
        console.log(`Added fstab entry for UUID=${uuid}`);
    }
}
