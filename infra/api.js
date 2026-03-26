import { spawnSync } from 'child_process';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import mongodb from 'mongodb';
const { MongoClient } = mongodb;
import { EJSON } from 'bson';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, 'bin/infra-compose');
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

// ── Docker lifecycle (delegates to bin/infra-compose) ──────────────

/**
 * Start Docker services (detached).
 * @param {{ profile?: string, seed_dir?: string, data_dir?: string }} options
 */
export async function up(options = {}) {
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

    let result = spawnSync('docker', ['compose', 'up', '-d'], { cwd: __dirname, env, stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') {
        result = spawnSync('docker-compose', ['up', '-d'], { cwd: __dirname, env, stdio: 'inherit' });
    }
    if (result.error) throw result.error;
    if (result.status === 0 && profile) write_active_profile(profile);
    return { exitCode: result.status ?? 1 };
}

/** @param {{ profile: string }} options */
export function switch_profile(options) {
    const result = spawnSync(BIN, ['switch', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
    if (result.status === 0) write_active_profile(options.profile);
    return result;
}

/** @param {{ profile: string }} options */
export function reset(options) {
    const result = spawnSync(BIN, ['reset', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
    if (result.status === 0) write_active_profile(options.profile);
    return result;
}

/** @param {{ profile: string }} options */
export function restore(options) {
    return spawnSync(BIN, ['restore', '--profile', options.profile], { stdio: 'inherit', cwd: __dirname });
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
    const profiles = [];

    for (const svc of ['mongo', 'mysql', 'postgres']) {
        const ext = svc === 'mongo' ? 'json' : 'sql';
        const seen = new Set();

        // Scan built-in seeds
        const builtin_dir = resolve(services_dir, svc, 'seed');
        scan_profiles(builtin_dir, ext, svc, profiles, seen);

        // Scan user data dir
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
