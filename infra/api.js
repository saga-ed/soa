import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import mongodb from 'mongodb';
const { MongoClient } = mongodb;
import { EJSON } from 'bson';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(homedir(), '.fixtures', 'profiles');
const ACTIVE_PROFILE_FILE = resolve(homedir(), '.fixtures', 'active-profile');

function write_active_profile(profile) {
    mkdirSync(dirname(ACTIVE_PROFILE_FILE), { recursive: true });
    writeFileSync(ACTIVE_PROFILE_FILE, JSON.stringify({
        profile,
        switched_at: new Date().toISOString(),
    }));
}

/** Get the currently active profile, or null if unknown. */
export function get_active_profile() {
    try {
        const content = readFileSync(ACTIVE_PROFILE_FILE, 'utf8').trim();
        if (!content) return null;
        // Support both old format (plain string) and new format (JSON)
        if (content.startsWith('{')) return JSON.parse(content);
        return { profile: content, switched_at: null };
    } catch {
        return null;
    }
}

const EXCLUDED_MONGO_DBS = ['admin', 'config', 'local'];
const EXCLUDED_MONGO_COLLECTIONS = ['_profile_meta'];
const EXCLUDED_MYSQL_DBS = ['information_schema', 'mysql', 'performance_schema', 'sys', '_profile_meta'];

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

// ── Docker helpers ─────────────────────────────────────────────────

/**
 * Build the env object for docker compose commands.
 * Merges process.env + .env.defaults + .env, with optional profile and seed_dir.
 */
function build_compose_env(options = {}) {
    const { profile, seed_dir, data_dir } = options;
    const env = { ...process.env, ...load_env_defaults() };
    if (profile) env.SEED_PROFILE = profile;
    if (seed_dir) {
        const base = resolve(seed_dir);
        env.EXTRA_MYSQL_SEED_DIR = resolve(base, 'mysql');
        env.EXTRA_MONGO_SEED_DIR = resolve(base, 'mongo');
        env.EXTRA_POSTGRES_SEED_DIR = resolve(base, 'postgres');
    }
    env.INFRA_COMPOSE_DATA_DIR = resolve(data_dir || DEFAULT_DATA_DIR);
    return env;
}

/**
 * Run a docker compose command, with fallback to docker-compose.
 * @param {string[]} args - compose subcommand args (e.g. ['up', '-d'])
 * @param {Record<string, string>} env
 * @returns {import('child_process').SpawnSyncReturns<Buffer>}
 */
function compose_cmd(args, env) {
    let result = spawnSync('docker', ['compose', ...args], { cwd: __dirname, env, stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') {
        result = spawnSync('docker-compose', args, { cwd: __dirname, env, stdio: 'inherit' });
    }
    return result;
}

/**
 * List Docker volume names matching a profile filter.
 * @param {string} profile
 * @returns {string[]}
 */
function list_profile_volumes(profile) {
    const result = spawnSync('docker', [
        'volume', 'ls', '--filter', `name=-profile-${profile}`, '--format', '{{.Name}}',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
}

/**
 * Remove Docker volumes by name (batch).
 * @param {string[]} volumes
 * @returns {{ status: number }}
 */
function remove_volumes(volumes) {
    if (volumes.length === 0) return { status: 0 };
    const result = spawnSync('docker', ['volume', 'rm', ...volumes], { stdio: 'inherit' });
    return { status: result.status ?? 1 };
}

// ── Docker lifecycle ──────────────────────────────────────────────

/**
 * Start Docker services (detached).
 * @param {{ profile?: string, seed_dir?: string, data_dir?: string }} options
 */
export async function up(options = {}) {
    const { profile } = options;
    const env = build_compose_env(options);

    const result = compose_cmd(['up', '-d'], env);
    if (result.error) throw result.error;
    if (result.status === 0 && profile) write_active_profile(profile);
    return { exitCode: result.status ?? 1 };
}

/**
 * Switch to a different database profile (down + up with new volumes).
 * @param {{ profile: string, seed_dir?: string, data_dir?: string }} options
 * @returns {{ status: number, profile: string }}
 */
export function switch_profile(options) {
    const { profile } = options;
    const env = build_compose_env(options);

    // Down
    const down = compose_cmd(['down'], env);
    if (down.status !== 0) return { status: down.status ?? 1, profile };

    // Up with new profile
    const up = compose_cmd(['up', '-d'], env);
    if (up.status === 0) write_active_profile(profile);
    return { status: up.status ?? 1, profile };
}

/**
 * Reset a profile: stop services, wipe profile volumes, restart fresh.
 * @param {{ profile: string, seed_dir?: string, data_dir?: string }} options
 * @returns {{ status: number, profile: string }}
 */
export function reset(options) {
    const { profile } = options;
    const env = build_compose_env(options);

    // Down
    const down = compose_cmd(['down'], env);
    if (down.status !== 0) return { status: down.status ?? 1, profile };

    // Remove profile volumes
    const volumes = list_profile_volumes(profile);
    if (volumes.length > 0) {
        console.log(`Removing ${volumes.length} volume(s) for profile: ${profile}`);
        const rm = remove_volumes(volumes);
        if (rm.status !== 0) return { status: rm.status, profile };
    }

    // Up — fresh seed
    const up = compose_cmd(['up', '-d'], env);
    if (up.status === 0) write_active_profile(profile);
    return { status: up.status ?? 1, profile };
}

/**
 * Restore a profile from seed/snapshot files (reset + re-seed).
 * If profile volumes exist, wipes them first. Otherwise starts fresh.
 * @param {{ profile: string, seed_dir?: string, data_dir?: string }} options
 * @returns {{ status: number, profile: string }}
 */
export function restore(options) {
    const { profile } = options;
    const services_dir = resolve(__dirname, 'services');

    // Verify at least one seed file exists for this profile
    const seed_files = [
        resolve(services_dir, 'mongo', 'seed', `profile-${profile}.json`),
        resolve(services_dir, 'mysql', 'seed', `profile-${profile}.sql`),
        resolve(services_dir, 'postgres', 'seed', `profile-${profile}.sql`),
    ];
    const has_seed = seed_files.some(f => existsSync(f));

    // Also check user data dir for snapshots
    const data_dir = resolve(options.data_dir || DEFAULT_DATA_DIR);
    const snapshot_files = [
        resolve(data_dir, 'mongo', `profile-${profile}.json`),
        resolve(data_dir, 'mysql', `profile-${profile}.sql`),
        resolve(data_dir, 'postgres', `profile-${profile}.sql`),
    ];
    const has_snapshot = snapshot_files.some(f => existsSync(f));

    if (!has_seed && !has_snapshot) {
        console.error(`Error: no seed or snapshot files found for profile '${profile}'`);
        return { status: 1, profile };
    }

    // If volumes exist, reset (wipe + re-seed). Otherwise just start fresh.
    const volumes = list_profile_volumes(profile);
    if (volumes.length > 0) {
        console.log(`Existing volumes found — resetting profile: ${profile}`);
        return reset(options);
    } else {
        console.log(`No existing volumes — starting fresh for profile: ${profile}`);
        const env = build_compose_env(options);
        const result = compose_cmd(['up', '-d'], env);
        if (result.status === 0) write_active_profile(profile);
        return { status: result.status ?? 1, profile };
    }
}

/**
 * Delete snapshot files for a profile from the user data directory.
 * Does NOT remove Docker volumes — use reset() for that.
 * @param {{ profile: string, data_dir?: string }} options
 */
export function delete_profile_data(options) {
    const { profile, data_dir } = options;
    const base = resolve(data_dir || DEFAULT_DATA_DIR);
    let deleted = 0;

    for (const [svc, ext] of [['mongo', 'json'], ['mysql', 'sql'], ['postgres', 'sql']]) {
        const file = resolve(base, svc, `profile-${profile}.${ext}`);
        if (existsSync(file)) {
            unlinkSync(file);
            deleted++;
            console.log(`Deleted: ${file}`);
        }
    }

    return { deleted, profile };
}

// ── Data operations (native JS) ────────────────────────────────────

/**
 * Snapshot current database state to profile files.
 * Uses mongodb driver and mysql2 directly — no shell-out to mongosh/mysqldump.
 *
 * @param {{ profile: string, services?: string[], output_dir?: string, force?: boolean }} options
 */
export async function snapshot(options) {
    const { profile, services = ['mongo', 'mysql'], output_dir, force = false } = options;
    const out_base = resolve(output_dir || DEFAULT_DATA_DIR);
    const defaults = load_env_defaults();

    console.log(`Snapshot: profile=${profile} output=${out_base}`);
    console.log(`Services: ${services.join(' ')}`);

    for (const svc of services) {
        const ext = svc === 'mongo' ? 'json' : 'sql';
        const out_dir = resolve(out_base, svc);
        const out_file = resolve(out_dir, `profile-${profile}.${ext}`);

        if (!force && existsSync(out_file)) {
            console.error(`Error: ${out_file} already exists. Use force=true to overwrite.`);
            return { status: 1 };
        }
        mkdirSync(out_dir, { recursive: true });

        try {
            if (svc === 'mongo') {
                await snapshot_mongo(profile, out_dir, defaults);
            } else if (svc === 'mysql') {
                await snapshot_mysql(profile, out_dir, defaults);
            }
        } catch (err) {
            console.error(`Snapshot ${svc} failed:`, err.message);
            return { status: 1 };
        }
    }

    console.log(`\nSnapshot complete. Profile '${profile}' saved.`);
    return { status: 0 };
}

/** Backward-compat alias */
export const dump = snapshot;

async function snapshot_mongo(profile, out_dir, defaults) {
    const port = defaults.MONGO_PORT || '27017';
    const uri = `mongodb://localhost:${port}`;
    const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000 });

    console.log(`\n── Mongo (${uri}) ──`);
    await client.connect();

    try {
        const admin = client.db('admin').admin();
        const { databases } = await admin.listDatabases();
        const result = {};

        for (const dbInfo of databases) {
            if (EXCLUDED_MONGO_DBS.includes(dbInfo.name)) continue;

            const db = client.db(dbInfo.name);
            const collections = (await db.listCollections().toArray())
                .map(c => c.name)
                .filter(n => !EXCLUDED_MONGO_COLLECTIONS.includes(n) && !n.startsWith('system.'));

            if (collections.length === 0) continue;

            console.log(`  db: ${dbInfo.name}`);
            result[dbInfo.name] = {};

            for (const collName of collections) {
                const docs = await db.collection(collName).find({}).toArray();
                if (docs.length === 0) continue;

                // Convert BSON types to JSON-safe representations
                const cleaned = docs.map(doc => JSON.parse(EJSON.stringify(doc, { relaxed: true })));
                result[dbInfo.name][collName] = cleaned;
                console.log(`    ${collName}: ${cleaned.length} docs`);
            }
        }

        // Add snapshot metadata
        result['_meta'] = { type: 'snapshot', profile, dumped_at: new Date().toISOString() };

        const out_file = resolve(out_dir, `profile-${profile}.json`);
        const json = JSON.stringify(result, null, 2);
        writeFileSync(out_file, json);
        console.log(`  Wrote ${out_file} (${json.length} bytes)`);
    } finally {
        await client.close();
    }
}

async function snapshot_mysql(profile, out_dir, defaults) {
    const port = parseInt(defaults.MYSQL_PORT || '3306', 10);
    const password = defaults.MYSQL_PASSWORD || 'password123';

    console.log(`\n── MySQL (127.0.0.1:${port}) ──`);
    const conn = await mysql.createConnection({
        host: '127.0.0.1', port, user: 'root', password,
    });

    try {
        // Get user databases
        const [rows] = await conn.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (${EXCLUDED_MYSQL_DBS.map(() => '?').join(',')})`,
            EXCLUDED_MYSQL_DBS
        );
        const databases = rows.map(r => r.SCHEMA_NAME || r.schema_name);

        if (databases.length === 0) {
            console.log('  No user databases found — nothing to snapshot');
            return;
        }

        // Build SQL dump
        const lines = [
            `-- @infra-compose/snapshot`,
            `-- Profile: ${profile}`,
            `-- Dumped at: ${new Date().toISOString()}`,
            `-- Source: infra-compose snapshot (native JS)`,
            `--`,
            ``,
            `SET FOREIGN_KEY_CHECKS=0;`,
            `SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';`,
            ``,
        ];

        for (const db of databases) {
            console.log(`  db: ${db}`);
            lines.push(`CREATE DATABASE IF NOT EXISTS \`${db}\`;`);
            lines.push(`USE \`${db}\`;`);
            lines.push(``);

            // Get tables
            const [tables] = await conn.query(`SHOW FULL TABLES FROM \`${db}\` WHERE Table_type = 'BASE TABLE'`);
            const table_key = `Tables_in_${db}`;

            for (const table_row of tables) {
                const table_name = table_row[table_key];

                // CREATE TABLE
                const [create_rows] = await conn.query(`SHOW CREATE TABLE \`${db}\`.\`${table_name}\``);
                const create_sql = create_rows[0]['Create Table'];
                lines.push(`DROP TABLE IF EXISTS \`${table_name}\`;`);
                lines.push(`${create_sql};`);
                lines.push(``);

                // INSERT data
                const [data_rows] = await conn.query(`SELECT * FROM \`${db}\`.\`${table_name}\``);
                if (data_rows.length > 0) {
                    const columns = Object.keys(data_rows[0]);
                    const col_list = columns.map(c => `\`${c}\``).join(', ');

                    for (const row of data_rows) {
                        const values = columns.map(c => {
                            const v = row[c];
                            if (v === null) return 'NULL';
                            if (typeof v === 'number') return String(v);
                            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
                            if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
                            return `'${String(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
                        });
                        lines.push(`INSERT INTO \`${table_name}\` (${col_list}) VALUES (${values.join(', ')});`);
                    }
                    lines.push(``);
                }
            }
            lines.push(``);
        }

        lines.push(`SET FOREIGN_KEY_CHECKS=1;`);
        lines.push(``);

        const out_file = resolve(out_dir, `profile-${profile}.sql`);
        const sql = lines.join('\n');
        writeFileSync(out_file, sql);
        console.log(`  Wrote ${out_file} (${sql.length} bytes)`);
    } finally {
        await conn.end();
    }
}

/**
 * List available profiles from both built-in seeds and user data directory.
 * @param {{ data_dir?: string }} options
 */
export function list_profiles(options = {}) {
    const data_dir = resolve(options.data_dir || DEFAULT_DATA_DIR);
    const services_dir = resolve(__dirname, 'services');
    const defaults = load_env_defaults();
    const profiles = [];

    const extra_dirs = {
        mongo: defaults.EXTRA_MONGO_SEED_DIR,
        mysql: defaults.EXTRA_MYSQL_SEED_DIR,
        postgres: defaults.EXTRA_POSTGRES_SEED_DIR,
    };

    for (const svc of ['mongo', 'mysql', 'postgres']) {
        const ext = svc === 'mongo' ? 'json' : 'sql';
        const seen = new Set();

        // Scan built-in seeds
        const builtin_dir = resolve(services_dir, svc, 'seed');
        scan_profiles(builtin_dir, ext, svc, profiles, seen);

        // Scan project-provided extra seeds (e.g., fixture-cli's saga-api profile)
        const extra_dir = extra_dirs[svc];
        if (extra_dir) scan_profiles(resolve(extra_dir), ext, svc, profiles, seen);

        // Scan user data dir (snapshots)
        const user_dir = resolve(data_dir, svc);
        scan_profiles(user_dir, ext, svc, profiles, seen);
    }

    return { profiles };
}

function scan_profiles(dir, ext, service, profiles, seen) {
    if (!existsSync(dir)) return;

    const pattern = `profile-`;
    for (const file of readdirSync(dir)) {
        if (!file.startsWith(pattern) || !file.endsWith(`.${ext}`)) continue;
        const name = file.slice(pattern.length, -(ext.length + 1));
        const key = `${service}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Detect type: snapshot vs seed
        let type = 'seed';
        const filepath = resolve(dir, file);
        try {
            if (ext === 'json') {
                const content = readFileSync(filepath, 'utf8');
                if (content.includes('"_meta"') && content.includes('"snapshot"')) type = 'snapshot';
            } else {
                // Check first line for snapshot marker
                const content = readFileSync(filepath, 'utf8');
                if (content.startsWith('-- @infra-compose/snapshot')) type = 'snapshot';
            }
        } catch { /* ignore read errors */ }

        profiles.push({ name, type, service });
    }
}
