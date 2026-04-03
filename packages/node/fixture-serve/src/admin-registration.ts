/**
 * Self-registration with fixture-admin service.
 *
 * On startup, the fixture server registers itself so the fixture-admin UI
 * can discover available hosts. Uses EC2 IMDSv2 to fetch the instance's
 * private IP when running on EC2, falls back to 127.0.0.1 for local dev.
 */

import { hostname } from 'os';
import { get_active_profile } from '@saga-ed/infra-compose';
import type { ILogger } from '@saga-ed/soa-logger';

export interface AdminRegistrationConfig {
    /** URL to POST registration to. */
    admin_url: string;
    /** Port the fixture server is listening on. */
    port: number;
    /** Base site URL (e.g. "https://snapper.wootmath.com"). */
    site_url: string;
    /** Package version string. */
    version: string;
}

export async function register_with_admin(config: AdminRegistrationConfig, logger: ILogger): Promise<void> {
    const vm_name = hostname().split('.')[0] || 'unknown';

    // Fetch private IP from EC2 instance metadata (IMDSv2)
    let private_ip = '127.0.0.1';
    try {
        const token_resp = await fetch('http://169.254.169.254/latest/api/token', {
            method: 'PUT',
            headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
            signal: AbortSignal.timeout(2000),
        });
        const token = await token_resp.text();
        const ip_resp = await fetch('http://169.254.169.254/latest/meta-data/local-ipv4', {
            headers: { 'X-aws-ec2-metadata-token': token },
            signal: AbortSignal.timeout(2000),
        });
        private_ip = (await ip_resp.text()).trim();
    } catch {
        logger.warn('register_with_admin: could not fetch EC2 metadata (not on EC2?)');
    }

    const active = get_active_profile();
    const body = {
        hostname: vm_name,
        private_ip,
        port: config.port,
        site_url: config.site_url,
        version: config.version,
        active_profile: active?.profile || null,
        display_name: `${vm_name.charAt(0).toUpperCase() + vm_name.slice(1)} (Dev)`,
    };

    try {
        const resp = await fetch(config.admin_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
            logger.info(`Registered with fixture-admin: ${vm_name} (${private_ip}:${config.port})`);
        } else {
            logger.warn(`register_with_admin: ${resp.status} ${resp.statusText}`);
        }
    } catch (err: any) {
        logger.warn(`register_with_admin: ${err.message} (will retry on next restart)`);
    }
}
