/**
 * AWS Cloud Map service discovery for the EC2 db-host.
 * Uses spawnSync for AWS CLI calls (no shell injection risk — all args are positional).
 */

import { spawnSync } from 'child_process';

const DELETE_ATTEMPTS = 5;
const DELETE_RETRY_MS = 2000;

// The router calls teardown synchronously; Atomics.wait is the only way to
// block without restructuring every caller onto promises.
function sleep_sync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(args) {
    const result = spawnSync('aws', args, { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) {
        throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${result.stderr || result.error}`);
    }
    return result.stdout.trim();
}

// Returns null ONLY when the namespace listed successfully and the name was
// absent. A failed list must propagate: "couldn't look" and "isn't there" lead
// to opposite actions in both callers below.
function find_service(name, namespace_id, region) {
    const result = JSON.parse(run([
        'servicediscovery', 'list-services',
        '--filters', `Name=NAMESPACE_ID,Values=${namespace_id},Condition=EQ`,
        '--region', region,
        '--output', 'json',
    ]));
    return result.Services.find(s => s.Name === name) || null;
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

        try {
            const result = JSON.parse(run([
                'servicediscovery', 'create-service',
                '--name', name,
                '--dns-config', dns_config,
                '--region', region,
                '--output', 'json',
            ]));
            service = result.Service;
            console.log(`Created CloudMap service: ${name} (${service.Id})`);
        } catch (err) {
            // A service surviving without its DB container is reusable, not
            // fatal: the name is the only thing CreateService reserves, and a
            // provision that dies here strands the identifier permanently —
            // deleting the leftover needs servicediscovery:DeleteService, which
            // no operator tier currently holds (hipponot/iac#672).
            if (!/ServiceAlreadyExists/.test(err.message)) throw err;
            service = find_service(name, namespace_id, region);
            if (!service) {
                throw new Error(
                    `CloudMap reports service '${name}' exists but it is absent from namespace `
                    + `${namespace_id}; cannot resolve its id to reuse it`,
                    { cause: err },
                );
            }
            console.log(`Reusing existing CloudMap service: ${name} (${service.Id})`);
        }
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

    // A surviving service blocks that identifier from ever being provisioned
    // again, so a failed delete has to reach the caller rather than tail off
    // into a log line. DeregisterInstance is asynchronous and DeleteService
    // rejects a service that still has one, so retry across that window.
    let last_err;
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
        try {
            run([
                'servicediscovery', 'delete-service',
                '--id', service.Id,
                '--region', region,
            ]);
            console.log(`Deleted CloudMap service: ${name}`);
            return;
        } catch (err) {
            last_err = err;
            if (!/ResourceInUse/.test(err.message)) break;
            sleep_sync(DELETE_RETRY_MS);
        }
    }

    throw new Error(
        `Could not delete CloudMap service ${name}: ${last_err.message}`,
        { cause: last_err },
    );
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
