import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
// services.ts → lib → src → integration-tests → packages → repo root (5 ups)
const REPO_ROOT = resolve(here, '../../../../..');
export const IDENTITY_SVC = resolve(REPO_ROOT, 'apps/identity-svc');
export const ADMISSIONS_SVC = resolve(REPO_ROOT, 'apps/admissions-svc');

/**
 * Run `prisma migrate deploy` against a fresh test database to bring it up
 * to the current schema. Uses the service-local prisma binary (avoids needing
 * pnpm on PATH inside the test process). Synchronous because vitest's beforeAll
 * handles awaits.
 */
export function migrate(serviceDir: string, databaseUrl: string): void {
    const prismaBin = resolve(serviceDir, 'node_modules', '.bin', 'prisma');
    execFileSync(prismaBin, ['migrate', 'deploy'], {
        cwd: serviceDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
    });
}

export interface SpawnedService {
    proc: ChildProcess;
    baseUrl: string;
    stop: () => Promise<void>;
}

export interface SpawnOpts {
    serviceDir: string;
    port: number;
    env: Record<string, string>;
}

export function spawnService(opts: SpawnOpts): SpawnedService {
    const proc = spawn('node', ['dist/main.js'], {
        cwd: opts.serviceDir,
        env: {
            // Default OTel off in tests so spawned services don't spam stderr
            // about unreachable Jaeger. Per-test env can re-enable if needed.
            OTEL_TRACES_DISABLED: 'true',
            ...process.env,
            ...opts.env,
            PORT: String(opts.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const baseUrl = `http://localhost:${opts.port}`;

    // Surface logs from the subprocess so test output shows what failed.
    proc.stdout?.on('data', (data: Buffer) => {
        process.stdout.write(`[${opts.serviceDir.split('/').pop()}] ${data.toString()}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(`[${opts.serviceDir.split('/').pop()}:err] ${data.toString()}`);
    });

    const stop = async (): Promise<void> => {
        if (proc.exitCode !== null) return;
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve();
            }, 5_000);
            proc.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
    };

    return { proc, baseUrl, stop };
}
