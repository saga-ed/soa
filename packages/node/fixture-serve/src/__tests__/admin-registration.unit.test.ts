import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockLogger } from '@saga-ed/soa-logger';
import { register_with_admin } from '../server/admin-registration.js';

vi.mock('@saga-ed/infra-compose', () => ({
    get_active_profile: vi.fn(() => ({ profile: 'basic' })),
}));

describe('register_with_admin', () => {
    let fetch_spy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetch_spy = vi.fn();
        vi.stubGlobal('fetch', fetch_spy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('posts registration payload with expected shape when fetch succeeds', async () => {
        fetch_spy
            .mockResolvedValueOnce({ ok: true, text: async () => 'TOKEN' })
            .mockResolvedValueOnce({ ok: true, text: async () => '10.0.1.42' })
            .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });

        const logger = new MockLogger();
        await register_with_admin({
            admin_url: 'http://admin.test/register',
            port: 7777,
            site_url: 'https://snapper.test',
            version: '0.2.6',
        }, logger);

        expect(fetch_spy).toHaveBeenCalledTimes(3);
        const admin_call = fetch_spy.mock.calls[2];
        expect(admin_call[0]).toBe('http://admin.test/register');
        expect(admin_call[1].method).toBe('POST');

        const body = JSON.parse(admin_call[1].body);
        expect(body).toMatchObject({
            private_ip: '10.0.1.42',
            port: 7777,
            site_url: 'https://snapper.test',
            version: '0.2.6',
            active_profile: 'basic',
        });
        expect(body.hostname).toBeTypeOf('string');
        expect(body.hostname.length).toBeGreaterThan(0);
        expect(body.display_name).toMatch(/ \(Dev\)$/);

        expect(logger.logs.find(l => l.level === 'info' && l.message.includes('Registered'))).toBeDefined();
    });

    it('falls back to 127.0.0.1 when EC2 IMDSv2 is unreachable', async () => {
        fetch_spy
            .mockRejectedValueOnce(new Error('ENETUNREACH'))
            .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });

        const logger = new MockLogger();
        await register_with_admin({
            admin_url: 'http://admin.test/register',
            port: 7777,
            site_url: 'http://localhost:3000',
            version: '0.2.6',
        }, logger);

        const admin_call = fetch_spy.mock.calls.find(c => c[0] === 'http://admin.test/register');
        expect(admin_call).toBeDefined();
        const body = JSON.parse(admin_call![1].body);
        expect(body.private_ip).toBe('127.0.0.1');

        expect(logger.logs.find(l => l.level === 'warn' && l.message.includes('could not fetch EC2 metadata'))).toBeDefined();
    });

    it('logs warning (does not throw) when admin returns non-ok', async () => {
        fetch_spy
            .mockRejectedValueOnce(new Error('not on ec2'))
            .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

        const logger = new MockLogger();
        await register_with_admin({
            admin_url: 'http://admin.test/register',
            port: 7777,
            site_url: 'http://localhost:3000',
            version: '0.2.6',
        }, logger);

        expect(logger.logs.find(l => l.level === 'warn' && l.message.includes('500'))).toBeDefined();
    });

    it('logs warning (does not throw) when admin fetch itself throws', async () => {
        fetch_spy
            .mockRejectedValueOnce(new Error('not on ec2'))
            .mockRejectedValueOnce(new Error('connection refused'));

        const logger = new MockLogger();
        await register_with_admin({
            admin_url: 'http://admin.test/register',
            port: 7777,
            site_url: 'http://localhost:3000',
            version: '0.2.6',
        }, logger);

        expect(logger.logs.find(l => l.level === 'warn' && l.message.includes('connection refused'))).toBeDefined();
    });

    it('sets active_profile to null when get_active_profile returns undefined', async () => {
        const { get_active_profile } = await import('@saga-ed/infra-compose');
        (get_active_profile as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

        fetch_spy
            .mockRejectedValueOnce(new Error('not on ec2'))
            .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });

        await register_with_admin({
            admin_url: 'http://admin.test/register',
            port: 7777,
            site_url: 'http://localhost:3000',
            version: '0.2.6',
        }, new MockLogger());

        const admin_call = fetch_spy.mock.calls.find(c => c[0] === 'http://admin.test/register');
        const body = JSON.parse(admin_call![1].body);
        expect(body.active_profile).toBeNull();
    });
});
