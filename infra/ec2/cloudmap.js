/**
 * AWS Cloud Map service discovery for the EC2 db-host.
 * Uses spawnSync for AWS CLI calls (no shell injection risk — all args are positional).
 */

import { spawnSync } from 'child_process';

function run(args) {
    const result = spawnSync('aws', args, { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) {
        throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${result.stderr || result.error}`);
    }
    return result.stdout.trim();
}

function find_service(name, namespace_id, region) {
    try {
        const result = JSON.parse(run([
            'servicediscovery', 'list-services',
            '--filters', `Name=NAMESPACE_ID,Values=${namespace_id},Condition=EQ`,
            '--region', region,
            '--output', 'json',
        ]));
        return result.Services.find(s => s.Name === name) || null;
    } catch {
        return null;
    }
}

/**
 * Register a database in Cloud Map for service discovery.
 * Creates the service if it doesn't exist, then registers an instance.
 * @param {{ name: string, ip: string, port: number, namespace_id: string, region: string }} config
 */
export function register({ name, ip, port, namespace_id, region }) {
    let service = find_service(name, namespace_id, region);

    if (!service) {
        const dns_config = JSON.stringify({
            NamespaceId: namespace_id,
            DnsRecords: [{ Type: 'A', TTL: 60 }],
        });

        const result = JSON.parse(run([
            'servicediscovery', 'create-service',
            '--name', name,
            '--dns-config', dns_config,
            '--region', region,
            '--output', 'json',
        ]));
        service = result.Service;
        console.log(`Created CloudMap service: ${name} (${service.Id})`);
    }

    const attributes = JSON.stringify({
        AWS_INSTANCE_IPV4: ip,
        AWS_INSTANCE_PORT: String(port),
    });

    run([
        'servicediscovery', 'register-instance',
        '--service-id', service.Id,
        '--instance-id', name,
        '--attributes', attributes,
        '--region', region,
    ]);
    console.log(`Registered CloudMap instance: ${name} -> ${ip}:${port}`);
}

/**
 * Deregister a database from Cloud Map and delete the service.
 * @param {{ name: string, namespace_id: string, region: string }} config
 */
export function deregister({ name, namespace_id, region }) {
    const service = find_service(name, namespace_id, region);
    if (!service) {
        console.log(`CloudMap service not found: ${name}`);
        return;
    }

    try {
        run([
            'servicediscovery', 'deregister-instance',
            '--service-id', service.Id,
            '--instance-id', name,
            '--region', region,
        ]);
        console.log(`Deregistered CloudMap instance: ${name}`);
    } catch (err) {
        console.log(`No instance to deregister for ${name}: ${err.message}`);
    }

    try {
        run([
            'servicediscovery', 'delete-service',
            '--id', service.Id,
            '--region', region,
        ]);
        console.log(`Deleted CloudMap service: ${name}`);
    } catch (err) {
        console.log(`Could not delete service ${name}: ${err.message}`);
    }
}

/**
 * List all services in a Cloud Map namespace.
 * @param {{ namespace_id: string, region: string }} config
 * @returns {Array<{ name: string, id: string }>}
 */
export function list_services({ namespace_id, region }) {
    const result = JSON.parse(run([
        'servicediscovery', 'list-services',
        '--filters', `Name=NAMESPACE_ID,Values=${namespace_id},Condition=EQ`,
        '--region', region,
        '--output', 'json',
    ]));
    return result.Services.map(s => ({ name: s.Name, id: s.Id }));
}
