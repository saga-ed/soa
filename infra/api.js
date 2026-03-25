import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, 'bin/infra-compose');

function parse_env_file(filepath) {
    if (!existsSync(filepath)) return {};
    const content = readFileSync(filepath, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
}

/** Load env: .env.defaults first, then .env overrides (mirrors bin/infra-compose behavior). */
function load_env_defaults() {
    return {
        ...parse_env_file(resolve(__dirname, '.env.defaults')),
        ...parse_env_file(resolve(__dirname, '.env')),
    };
}

/**
 * Start Docker services (detached).
 * Tries `docker compose` (v2 plugin) first, falls back to `docker-compose` (v1 standalone).
 * @param {{ profile?: string, seed_dir?: string }} options
 * @param {string} [options.profile] - Seed profile name (sets SEED_PROFILE env var)
 * @param {string} [options.seed_dir] - Directory containing project-specific seed files.
 *   Mounted as /extra-seed/ in init containers. Project seeds take priority over built-in seeds.
 * @returns {Promise<{ exitCode: number }>}
 */
export async function up(options = {}) {
    const { profile, seed_dir } = options;
    const env = { ...process.env, ...load_env_defaults() };
    if (profile) env.SEED_PROFILE = profile;
    if (seed_dir) {
        const base = resolve(seed_dir);
        // Per-service seed dirs: seed_dir/mysql/, seed_dir/mongo/, etc.
        env.EXTRA_MYSQL_SEED_DIR = resolve(base, 'mysql');
        env.EXTRA_MONGO_SEED_DIR = resolve(base, 'mongo');
        env.EXTRA_POSTGRES_SEED_DIR = resolve(base, 'postgres');
    }

    // Try docker compose v2 first
    let result = spawnSync('docker', ['compose', 'up', '-d'], { cwd: __dirname, env, stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') {
        // Fall back to docker-compose v1
        result = spawnSync('docker-compose', ['up', '-d'], { cwd: __dirname, env, stdio: 'inherit' });
    }
    if (result.error) throw result.error;
    return { exitCode: result.status ?? 1 };
}

/** @param {{ profile: string, services?: string[], output_dir?: string, force?: boolean }} options */
export function dump(options) {
    const { profile, services, output_dir, force = false } = options;
    const args = ['dump', '--profile', profile];
    if (services?.length) args.push('--services', services.join(','));
    if (output_dir) args.push('--output-dir', output_dir);
    if (force) args.push('--force');
    return spawnSync(BIN, args, { stdio: 'inherit', cwd: __dirname });
}

/** @param {{ profile: string }} options */
export function restore(options) {
    return spawnSync(BIN, ['restore', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
}

/** @param {{ profile: string }} options */
export function switch_profile(options) {
    return spawnSync(BIN, ['switch', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
}

/** List available seed profiles across all services. */
export function list_profiles() {
    const result = spawnSync(BIN, ['list-profiles'], { stdio: 'pipe', cwd: __dirname, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { exitCode: result.status ?? 1, output: result.stdout ?? '' };
}

/** @param {{ profile: string }} options */
export function reset(options) {
    return spawnSync(BIN, ['reset', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
}
