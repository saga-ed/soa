/**
 * Profile management for EC2 db-host.
 * Handles snapshots (dump to S3), profile switching (wipe + re-seed),
 * and profile listing.
 *
 * Uses docker exec for SQL dumps (avoids version mismatch) and
 * mongosh eval for mongo exports.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { engines } from './engines.js';

const REGISTRY_FILE = '.profile-registry.json';

function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${result.stderr || result.error}`);
    }
    return result.stdout;
}

// --- Profile registry (tracks active profile per DB) ---

export function read_profile_registry(data_dir) {
    const path = resolve(data_dir, REGISTRY_FILE);
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

export function write_active_profile(name, profile, data_dir) {
    const path = resolve(data_dir, REGISTRY_FILE);
    const registry = read_profile_registry(data_dir);
    registry[name] = { active: profile, switched_at: new Date().toISOString() };
    const tmp = `${path}.tmp.${process.pid}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, path);
}

// --- Container name lookup (handles compose naming vs container_name) ---

function get_container_name(name, projects_dir) {
    const project_dir = resolve(projects_dir || '/opt/db-manager/projects', name);
    const ps = spawnSync('docker', ['compose', 'ps', '--format', '{{.Name}}'], {
        cwd: project_dir, encoding: 'utf8', stdio: 'pipe',
    });
    const container = (ps.stdout || '').trim().split('\n')[0];
    return container || name;
}

// --- Snapshot (dump live DB → S3) ---

export function snapshot_db({ name, profile, engine, port, db_name, db_user, db_password, bucket, projects_dir }) {
    const eng = engines[engine];
    if (!eng) throw new Error(`Unknown engine: ${engine}`);

    const ext = eng.seed_ext;
    const tmp_file = `/tmp/profile-${profile}.${ext}`;
    const s3_path = `s3://${bucket}/${name}/profile-${profile}.${ext}`;
    const effective_db_name = db_name || name;

    const container = get_container_name(name, projects_dir);

    if (engine === 'mongo') {
        snapshot_mongo({ container, tmp_file, user: db_user, password: db_password });
    } else {
        // postgres / mysql — use docker exec dump
        const dump_args = eng.dump_cmd(container, effective_db_name, db_user, db_password);
        const output = run(dump_args[0], dump_args.slice(1), { maxBuffer: 500 * 1024 * 1024 });
        writeFileSync(tmp_file, output);
        console.log(`Dumped ${engine} (${container}) to ${tmp_file} (${output.length} bytes)`);
    }

    // Upload to S3
    run('aws', ['s3', 'cp', tmp_file, s3_path]);
    console.log(`Uploaded snapshot to ${s3_path}`);

    return { s3_path, size: readFileSync(tmp_file).length };
}

function snapshot_mongo({ container, tmp_file, user, password }) {
    // Use mongosh via docker exec to export all collections as JSON
    const script = `
        const EXCLUDED_DBS = ['admin', 'config', 'local'];
        const EXCLUDED_COLLS = ['_profile_meta'];
        const result = {};
        const dbs = db.adminCommand({ listDatabases: 1 }).databases;
        for (const dbInfo of dbs) {
            if (EXCLUDED_DBS.includes(dbInfo.name)) continue;
            const target = db.getSiblingDB(dbInfo.name);
            const colls = target.getCollectionNames().filter(n => !EXCLUDED_COLLS.includes(n) && !n.startsWith('system.'));
            if (colls.length === 0) continue;
            result[dbInfo.name] = {};
            for (const c of colls) {
                const docs = target.getCollection(c).find({}).toArray();
                if (docs.length > 0) result[dbInfo.name][c] = docs;
            }
        }
        result['_meta'] = { type: 'snapshot', dumped_at: new Date().toISOString() };
        print(EJSON.stringify(result, { relaxed: true }));
    `;

    const args = ['exec', container, 'mongosh', '--quiet'];
    if (user && password) {
        args.push('-u', user, '-p', password, '--authenticationDatabase', 'admin');
    }
    args.push('--eval', script);

    const output = run('docker', args, { maxBuffer: 500 * 1024 * 1024 });

    // Parse and re-stringify for pretty formatting
    const parsed = JSON.parse(output.trim());
    writeFileSync(tmp_file, JSON.stringify(parsed, null, 2));
    console.log(`Dumped mongo (${container}) to ${tmp_file}`);
}

// --- Seed a running DB directly via docker exec ---

export function seed_after_start({ container, engine, seeds_dir, profile, db_user, db_password }) {
    const eng = engines[engine];
    if (!eng) throw new Error(`Unknown engine: ${engine}`);

    // Wait for container to be healthy (up to 60s)
    for (let i = 0; i < 30; i++) {
        const health = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', container], {
            encoding: 'utf8', stdio: 'pipe',
        });
        if ((health.stdout || '').trim() === 'healthy') break;
        spawnSync('sleep', ['2']);
    }

    if (engine === 'mongo') {
        const loader = resolve(seeds_dir, '01-seed.js');
        const seed_json = resolve(seeds_dir, `profile-${profile}.json`);
        if (!existsSync(loader) || !existsSync(seed_json)) return;

        // Copy files into container and execute
        run('docker', ['cp', seed_json, `${container}:/tmp/profile-${profile}.json`]);
        run('docker', ['cp', loader, `${container}:/tmp/01-seed.js`]);

        const args = ['exec', container, 'mongosh', '--quiet'];
        if (db_user && db_password) {
            args.push('-u', db_user, '-p', db_password, '--authenticationDatabase', 'admin');
        }
        args.push('--file', '/tmp/01-seed.js');
        const result = spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
        console.log(`Mongo seed output: ${result.stdout}`);
        if (result.status !== 0) console.log(`Mongo seed error: ${result.stderr}`);
    } else if (engine === 'postgres') {
        const seed_file = resolve(seeds_dir, '01-seed.sql');
        if (!existsSync(seed_file)) return;
        run('docker', ['cp', seed_file, `${container}:/tmp/01-seed.sql`]);
        const result = spawnSync('docker', [
            'exec', container, 'psql', '-U', db_user || 'postgres', '-f', '/tmp/01-seed.sql',
        ], { encoding: 'utf8', stdio: 'pipe' });
        console.log(`Postgres seed output: ${(result.stdout || '').slice(0, 500)}`);
        if (result.status !== 0) console.log(`Postgres seed error: ${result.stderr}`);
    } else if (engine === 'mysql') {
        const seed_file = resolve(seeds_dir, '01-seed.sql');
        if (!existsSync(seed_file)) return;
        run('docker', ['cp', seed_file, `${container}:/tmp/01-seed.sql`]);
        const args = ['exec', container, 'mysql', '-u', db_user || 'root'];
        if (db_password) args.push(`-p${db_password}`);
        args.push('-e', 'source /tmp/01-seed.sql');
        const result = spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
        console.log(`MySQL seed output: ${(result.stdout || '').slice(0, 500)}`);
        if (result.status !== 0) console.log(`MySQL seed error: ${result.stderr}`);
    }
}

// --- Download profile seed from S3 ---

export function download_profile_seed({ name, profile, engine, bucket, seeds_base }) {
    const eng = engines[engine];
    if (!eng) throw new Error(`Unknown engine: ${engine}`);

    const ext = eng.seed_ext;
    const seeds_dir = resolve(seeds_base, name);
    const s3_path = `s3://${bucket}/${name}/profile-${profile}.${ext}`;

    // Clear seeds dir
    if (existsSync(seeds_dir)) {
        for (const entry of readdirSync(seeds_dir)) {
            rmSync(resolve(seeds_dir, entry), { recursive: true, force: true });
        }
    }
    mkdirSync(seeds_dir, { recursive: true });

    if (engine === 'mongo') {
        // Download JSON seed file
        const seed_json = resolve(seeds_dir, `profile-${profile}.json`);
        run('aws', ['s3', 'cp', s3_path, seed_json]);

        // Write a mongosh loader script (executed via docker exec, reads from /tmp)
        const loader = `// Auto-generated loader for profile: ${profile}
const raw = fs.readFileSync('/tmp/profile-${profile}.json', 'utf8');
const spec = EJSON.parse(raw);
for (const [dbName, collections] of Object.entries(spec)) {
    if (dbName === '_meta') continue;
    const target = db.getSiblingDB(dbName);
    for (const [collName, docs] of Object.entries(collections)) {
        if (!Array.isArray(docs) || docs.length === 0) continue;
        target[collName].insertMany(docs);
        print('  ' + dbName + '.' + collName + ': ' + docs.length + ' docs');
    }
}
print('Seed complete: profile ${profile}');
`;
        writeFileSync(resolve(seeds_dir, '01-seed.js'), loader);
        console.log(`Prepared mongo seed: ${seeds_dir}`);
    } else {
        // SQL engines — download directly as the entrypoint seed file
        const seed_file = resolve(seeds_dir, `01-seed.${ext}`);
        run('aws', ['s3', 'cp', s3_path, seed_file]);
        console.log(`Downloaded ${ext} seed: ${seed_file}`);
    }

    return seeds_dir;
}

// --- List profiles available in S3 ---

export function list_s3_profiles({ name, engine, bucket }) {
    const eng = engines[engine];
    if (!eng) return [];

    const ext = eng.seed_ext;
    const s3_prefix = `s3://${bucket}/${name}/`;

    const ls = spawnSync('aws', ['s3', 'ls', s3_prefix], { encoding: 'utf8', stdio: 'pipe' });
    if (ls.status !== 0 || !ls.stdout.trim()) return [];

    const profiles = [];
    const pattern = new RegExp(`^\\S+\\s+\\S+\\s+(\\d+)\\s+profile-(.+)\\.${ext}$`);

    for (const line of ls.stdout.trim().split('\n')) {
        const match = line.match(pattern);
        if (match) {
            profiles.push({
                name: match[2],
                size: Number(match[1]),
                file: `profile-${match[2]}.${ext}`,
            });
        }
    }

    return profiles;
}
