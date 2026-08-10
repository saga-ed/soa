import { describe, it, expect, vi, beforeEach } from 'vitest';

// cloudmap.js shells out to the AWS CLI for every call; stubbing spawnSync lets
// each test drive the exact CLI responses that produced the live failures.
vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

import { spawnSync } from 'child_process';
import { register, deregister } from '../../src/ec2/cloudmap.js';

const NS = 'ns-test';
const REGION = 'us-west-2';
const NAME = 'rostering-scheduling-postgres-pr-568';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = stderr => ({ status: 1, stdout: '', stderr });

const list_of = (...services) => ok(JSON.stringify({ Services: services }));
const SERVICE_ALREADY_EXISTS = 'An error occurred (ServiceAlreadyExists) when calling '
    + 'the CreateService operation: Service already exists.';

// Route each stubbed call by the CLI subcommand so tests declare only the
// responses they care about, in any order the implementation makes them.
function route(handlers) {
    spawnSync.mockImplementation((_bin, args) => {
        const op = args[1];
        const handler = handlers[op];
        if (!handler) throw new Error(`unstubbed servicediscovery call: ${op}`);
        return typeof handler === 'function' ? handler() : handler;
    });
}

const calls_to = op => spawnSync.mock.calls.filter(([, args]) => args[1] === op);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('register', () => {
    it('reuses a leaked service instead of failing the provision', () => {
        // A teardown can remove the DB container but leave its Cloud Map entry;
        // create-service then returns ServiceAlreadyExists, and treating that as
        // fatal strands the identifier with no operator tier able to delete it.
        let listed = 0;
        route({
            'list-services': () => (listed++ === 0
                ? list_of()
                : list_of({ Name: NAME, Id: 'srv-leaked' })),
            'create-service': fail(SERVICE_ALREADY_EXISTS),
            'register-instance': ok(),
        });

        expect(() => register({
            name: NAME, ip: '10.3.142.176', port: 5440, namespace_id: NS, region: REGION,
        })).not.toThrow();

        // The reused service's id must be what the instance registers against.
        const [, args] = calls_to('register-instance')[0];
        expect(args).toContain('srv-leaked');
    });

    it('still fails when create-service fails for any other reason', () => {
        route({
            'list-services': list_of(),
            'create-service': fail('An error occurred (InvalidInput) when calling CreateService'),
        });

        expect(() => register({
            name: NAME, ip: '10.3.142.176', port: 5440, namespace_id: NS, region: REGION,
        })).toThrow(/InvalidInput/);
        expect(calls_to('register-instance')).toHaveLength(0);
    });

    it('does not call create-service when the service is already resolvable', () => {
        route({
            'list-services': list_of({ Name: NAME, Id: 'srv-existing' }),
            'register-instance': ok(),
        });

        register({ name: NAME, ip: '10.3.142.176', port: 5440, namespace_id: NS, region: REGION });

        expect(calls_to('create-service')).toHaveLength(0);
    });

    it('propagates a failed lookup rather than creating a duplicate', () => {
        // "couldn't list" must not read as "not there" — that sends provisioning
        // into create-service on a namespace it never actually saw.
        route({ 'list-services': fail('AccessDeniedException: ListServices') });

        expect(() => register({
            name: NAME, ip: '10.3.142.176', port: 5440, namespace_id: NS, region: REGION,
        })).toThrow(/ListServices/);
        expect(calls_to('create-service')).toHaveLength(0);
    });
});

describe('deregister', () => {
    it('reports a failed delete instead of logging and returning', () => {
        // A surviving service blocks the identifier's next provision, so
        // teardown must not report success when the delete never landed.
        route({
            'list-services': list_of({ Name: NAME, Id: 'srv-1' }),
            'deregister-instance': ok(),
            'delete-service': fail('An error occurred (InvalidInput) when calling DeleteService'),
        });

        expect(() => deregister({ name: NAME, namespace_id: NS, region: REGION }))
            .toThrow(/Could not delete CloudMap service/);
    });

    it('retries past the asynchronous deregister window', () => {
        // DeregisterInstance completes asynchronously and DeleteService rejects
        // a service that still has an instance attached.
        let attempts = 0;
        route({
            'list-services': list_of({ Name: NAME, Id: 'srv-1' }),
            'deregister-instance': ok(),
            'delete-service': () => (++attempts < 3
                ? fail('An error occurred (ResourceInUse) when calling DeleteService')
                : ok()),
        });

        expect(() => deregister({
            name: NAME, namespace_id: NS, region: REGION, delete_retry_ms: 1,
        })).not.toThrow();
        expect(attempts).toBe(3);
    });

    it('gives up after a bounded number of attempts', () => {
        // The bound is what limits how long a teardown can block the router,
        // so it needs pinning: an unbounded loop passes every other test here.
        let attempts = 0;
        route({
            'list-services': list_of({ Name: NAME, Id: 'srv-1' }),
            'deregister-instance': ok(),
            'delete-service': () => {
                attempts++;
                return fail('An error occurred (ResourceInUse) when calling DeleteService');
            },
        });

        expect(() => deregister({
            name: NAME, namespace_id: NS, region: REGION,
            delete_attempts: 3, delete_retry_ms: 1,
        })).toThrow(/Could not delete CloudMap service/);
        expect(attempts).toBe(3);
    });

    it('deletes the service even when no instance was registered', () => {
        route({
            'list-services': list_of({ Name: NAME, Id: 'srv-1' }),
            'deregister-instance': fail('InstanceNotFound'),
            'delete-service': ok(),
        });

        expect(() => deregister({ name: NAME, namespace_id: NS, region: REGION })).not.toThrow();
        expect(calls_to('delete-service')).toHaveLength(1);
    });
});
