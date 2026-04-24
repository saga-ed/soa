/**
 * Generic systemd service restart utility.
 *
 * Returns a factory function bound to a specific service pattern and health URL,
 * suitable for use as an infra-compose lifecycle hook.
 */

import { spawnSync } from 'child_process';
import type { ILogger } from '@saga-ed/soa-logger';

export interface ServiceRestarterOptions {
    /** Max time to wait for health check (ms). Default: 30000. */
    timeout_ms?: number;
    /** Interval between health check polls (ms). Default: 2500. */
    poll_interval_ms?: number;
}

/**
 * Create a service restarter function bound to a systemd unit pattern and health URL.
 *
 * @param service_pattern - Systemd unit pattern, e.g. "saga_api-*" or "adm_api-*"
 * @param health_url - Health check URL, e.g. "http://localhost:3000/health"
 * @param options - Timeout and polling configuration
 * @returns An async function that discovers, restarts, and health-checks the service
 *
 * @example
 * ```ts
 * const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health');
 * // Use as infra-compose lifecycle hook:
 * create_infra_router({ on_after_switch: restart });
 * ```
 */
export function create_service_restarter(
    service_pattern: string,
    health_url: string,
    options: ServiceRestarterOptions = {},
): (logger: ILogger) => Promise<void> {
    const { timeout_ms = 30000, poll_interval_ms = 2500 } = options;
    const max_polls = Math.ceil(timeout_ms / poll_interval_ms);

    return async function restart_service(logger: ILogger): Promise<void> {
        try {
            const discover = spawnSync('bash', ['-c',
                `systemctl list-units "${service_pattern}.service" --state=running --plain --no-legend 2>/dev/null | awk '{print $1}'`,
            ], { encoding: 'utf8', timeout: 5000 });
            const services = (discover.stdout || '').trim().split('\n').filter(Boolean);

            if (services.length === 0) {
                logger.info(`restart_service: no running ${service_pattern} services found, skipping`);
                return;
            }

            logger.info(`restart_service: restarting ${services.join(', ')}`);
            const restart = spawnSync('sudo', ['systemctl', 'restart', ...services], {
                encoding: 'utf8', timeout: 15000, stdio: 'pipe',
            });
            if (restart.status !== 0) {
                logger.warn(`restart_service: systemctl restart failed: ${restart.stderr}`);
                return;
            }

            for (let i = 0; i < max_polls; i++) {
                await new Promise(r => setTimeout(r, poll_interval_ms));
                try {
                    const resp = await fetch(health_url, { signal: AbortSignal.timeout(2000) });
                    if (resp.ok) {
                        logger.info(`restart_service: ${service_pattern} is healthy`);
                        return;
                    }
                } catch { /* still starting */ }
            }
            logger.warn(`restart_service: ${service_pattern} did not become healthy within ${timeout_ms}ms`);
        } catch (err: any) {
            logger.warn(`restart_service: ${err.message}`);
        }
    };
}
