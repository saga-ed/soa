/**
 * Express router for the EC2 db-host API.
 * Manages database lifecycle: create, start, stop, reset, delete.
 *
 * Follows the same { ok: true/false } response convention as the existing infra-compose router.
 */

import express from 'express';
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { engines } from './engines.js';
import { generate_compose } from './compose-generator.js';
import { allocate_port, release_port, get_allocated_ports } from './ports.js';
import { create_volume, attach_and_mount, get_instance_metadata } from './volumes.js';
import { register, deregister } from './cloudmap.js';
import { snapshot_db, download_profile_seed, seed_after_start, list_s3_profiles, read_profile_registry, write_active_profile } from './profiles.js';

const SEEDS_BASE = '/mnt/seeds';
const SEED_BUCKET = process.env.SEED_BUCKET || 'saga-db-seeds-dev';

function sync_seeds(name) {
    const seeds_dir = resolve(SEEDS_BASE, name);
    const s3_path = `s3://${SEED_BUCKET}/${name}/`;

    // Check if S3 prefix has any objects
    const ls = spawnSync('aws', ['s3', 'ls', s3_path], { encoding: 'utf8', stdio: 'pipe' });
    if (ls.status !== 0 || !ls.stdout.trim()) return null;

    mkdirSync(seeds_dir, { recursive: true });
    const sync = spawnSync('aws', ['s3', 'sync', s3_path, seeds_dir], { encoding: 'utf8', stdio: 'pipe' });
    if (sync.status !== 0) {
        console.log(`S3 seed sync failed for ${name}: ${sync.stderr}`);
        return null;
    }
    console.log(`Synced seeds from ${s3_path} to ${seeds_dir}`);
    return seeds_dir;
}

function get_compose_config(projects_dir, name, engine) {
    const compose_path = resolve(projects_dir, name, 'docker-compose.yml');
    // Docker defaults: postgres='postgres', mysql='root', mongo has no default user
    const docker_defaults = { postgres: 'postgres', mysql: 'root', mongo: '' };
    const defaults = { db_name: name, user: docker_defaults[engine] || 'root', password: '' };
    if (!existsSync(compose_path)) return defaults;
    const content = readFileSync(compose_path, 'utf8');

    const db_patterns = { postgres: /POSTGRES_DB:\s*"?(\w+)"?/, mysql: /MYSQL_DATABASE:\s*"?(\w+)"?/, mongo: /MONGO_INITDB_DATABASE:\s*"?(\w+)"?/ };
    const user_patterns = { postgres: /POSTGRES_USER:\s*"?(\w+)"?/, mysql: /MYSQL_USER:\s*"?(\w+)"?/, mongo: /MONGO_INITDB_ROOT_USERNAME:\s*"?(\w+)"?/ };
    const pw_patterns = { postgres: /POSTGRES_PASSWORD:\s*"?(\w+)"?/, mysql: /MYSQL_ROOT_PASSWORD:\s*"?(\w+)"?/, mongo: /MONGO_INITDB_ROOT_PASSWORD:\s*"?(\w+)"?/ };

    const db_match = content.match(db_patterns[engine]);
    const user_match = content.match(user_patterns[engine]);
    const pw_match = content.match(pw_patterns[engine]);

    return {
        db_name: db_match ? db_match[1] : name,
        user: user_match ? user_match[1] : defaults.user,
        password: pw_match ? pw_match[1] : defaults.password,
    };
}

function get_db_name(projects_dir, name, engine) {
    return get_compose_config(projects_dir, name, engine).db_name;
}

function compose_cmd(project_dir, args) {
    const result = spawnSync('docker', ['compose', ...args], {
        cwd: project_dir,
        encoding: 'utf8',
        stdio: 'pipe',
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function get_project_status(project_dir, name) {
    const result = compose_cmd(project_dir, ['ps', '--format', 'json']);
    if (result.status !== 0) return { name, status: 'unknown', error: result.stderr };

    try {
        const containers = result.stdout.trim()
            ? result.stdout.trim().split('\n').map(line => JSON.parse(line))
            : [];
        return {
            name,
            status: containers.length > 0 ? 'running' : 'stopped',
            containers: containers.map(c => ({
                name: c.Name,
                state: c.State,
                health: c.Health || 'N/A',
            })),
        };
    } catch {
        return { name, status: 'unknown' };
    }
}

/**
 * Create the EC2 db-host Express router.
 *
 * @param {{
 *   projects_dir?: string,
 *   data_dir?: string,
 *   namespace_id?: string,
 *   region?: string,
 *   registry_path?: string,
 *   on_after_create?: Function,
 *   on_after_delete?: Function,
 * }} config
 * @returns {express.Router}
 */
export function create_ec2_router(config = {}) {
    const {
        projects_dir = '/opt/db-manager/projects',
        data_dir = '/mnt/data',
        namespace_id,
        region,
        registry_path,
        on_after_create,
        on_after_delete,
    } = config;

    const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

    const router = express.Router();
    router.use(express.json());

    // Validate :name param on all /dbs/:name routes
    router.param('name', (req, res, next, name) => {
        if (!VALID_NAME.test(name)) {
            return res.status(400).json({ ok: false, error: 'Invalid name: must be alphanumeric, hyphens, or underscores only' });
        }
        next();
    });

    // GET /dbs — list all database projects with status
    router.get('/dbs', (req, res) => {
        try {
            mkdirSync(projects_dir, { recursive: true });
            const dirs = readdirSync(projects_dir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            const dbs = dirs.map(name => {
                const project_dir = resolve(projects_dir, name);
                return get_project_status(project_dir, name);
            });

            const ports = get_allocated_ports({ registry_path });
            for (const db of dbs) {
                if (ports[db.name]) {
                    db.engine = ports[db.name].engine;
                    db.port = ports[db.name].port;
                }
            }

            res.json({ ok: true, dbs });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs/sync — backfill port registry + CloudMap for pre-existing DBs
    // Must be registered before /dbs/:name routes to avoid Express matching "sync" as :name
    router.post('/dbs/sync', (_req, res) => {
        try {
            mkdirSync(projects_dir, { recursive: true });
            const dirs = readdirSync(projects_dir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            const registry = get_allocated_ports({ registry_path });
            const synced = [];

            for (const name of dirs) {
                const compose_path = resolve(projects_dir, name, 'docker-compose.yml');
                if (!existsSync(compose_path)) continue;

                // Skip if already in registry
                if (registry[name]) {
                    synced.push({ name, engine: registry[name].engine, port: registry[name].port, action: 'already_tracked' });
                    continue;
                }

                // Parse compose file for engine + port (simple regex — files follow consistent format)
                const content = readFileSync(compose_path, 'utf8');

                // Detect engine from image line: "image: postgres:16" or "image: mongo:7"
                const image_match = content.match(/image:\s*(\w+):/);
                const engine = image_match ? image_match[1] : null;
                if (!engine || !engines[engine]) {
                    synced.push({ name, error: `Unknown engine from image: ${image_match?.[1]}` });
                    continue;
                }

                // Detect host port from ports line: "5432:5432" or "27018:27017"
                const port_match = content.match(/"(\d+):\d+"/);
                const port = port_match ? Number(port_match[1]) : null;
                if (!port) {
                    synced.push({ name, error: 'Could not detect port' });
                    continue;
                }

                // Write to registry
                allocate_port(engine, name, { registry_path });
                // Overwrite with actual port (allocate_port may pick a different one)
                const updated_registry = get_allocated_ports({ registry_path });
                if (updated_registry[name] && updated_registry[name].port !== port) {
                    updated_registry[name].port = port;
                    writeFileSync(
                        registry_path || '/opt/db-manager/port-registry.json',
                        JSON.stringify(updated_registry, null, 2),
                    );
                }

                // Register in CloudMap
                if (namespace_id) {
                    try {
                        const ip = spawnSync('hostname', ['-I'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
                        register({ name, ip, port, namespace_id, region: region || get_instance_metadata().region });
                    } catch (err) {
                        synced.push({ name, engine, port, action: 'synced_registry_only', cloudmap_error: err.message });
                        continue;
                    }
                }

                synced.push({ name, engine, port, action: 'synced' });
            }

            res.json({ ok: true, synced });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs — create a new database
    router.post('/dbs', (req, res) => {
        try {
            const { name, engine, version, port, volume_size = 20, db_name } = req.body;

            if (!name || !engine) {
                return res.status(400).json({ ok: false, error: 'name and engine are required' });
            }
            if (!engines[engine]) {
                return res.status(400).json({ ok: false, error: `Unknown engine: ${engine}. Use: ${Object.keys(engines).join(', ')}` });
            }

            const effective_db_name = db_name || name;
            const project_dir = resolve(projects_dir, name);

            if (existsSync(project_dir)) {
                return res.status(409).json({ ok: false, error: `Project ${name} already exists` });
            }

            // Allocate port
            const allocated_port = port || allocate_port(engine, name, { registry_path });

            // Create EBS volume and mount
            const meta = get_instance_metadata();
            const effective_region = region || meta.region;
            const volume_id = create_volume({
                name,
                size: volume_size,
                az: meta.az,
                region: effective_region,
                env_name: process.env.ENV_NAME,
            });

            const mount_path = resolve(data_dir, name);
            attach_and_mount({
                volume_id,
                mount_path,
                instance_id: meta.instance_id,
                region: effective_region,
            });

            // Pull S3 seed data if available
            const seeds_dir = sync_seeds(name);

            // Generate compose file
            const compose_content = generate_compose({
                name,
                engine,
                version,
                port: allocated_port,
                db_name: effective_db_name,
                data_dir,
                seeds_dir,
            });

            mkdirSync(project_dir, { recursive: true });
            writeFileSync(resolve(project_dir, 'docker-compose.yml'), compose_content);

            // Start the service
            const up = compose_cmd(project_dir, ['up', '-d']);
            if (up.status !== 0) {
                return res.status(500).json({ ok: false, error: `docker compose up failed: ${up.stderr}` });
            }

            // Register with CloudMap
            if (namespace_id) {
                const ip = spawnSync('hostname', ['-I'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
                register({
                    name,
                    ip,
                    port: allocated_port,
                    namespace_id,
                    region: effective_region,
                });
            }

            const result = {
                ok: true,
                name,
                engine,
                version: version || engines[engine].default_version,
                port: allocated_port,
                volume_id,
                db_name: effective_db_name,
            };

            if (on_after_create) on_after_create(result);
            res.json(result);
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs/:name/start
    router.post('/dbs/:name/start', (req, res) => {
        try {
            const { name } = req.params;
            const project_dir = resolve(projects_dir, name);
            if (!existsSync(project_dir)) {
                return res.status(404).json({ ok: false, error: `Project ${name} not found` });
            }

            const result = compose_cmd(project_dir, ['up', '-d']);
            if (result.status !== 0) {
                return res.status(500).json({ ok: false, error: `start failed: ${result.stderr}` });
            }

            // Re-register in CloudMap
            if (namespace_id) {
                const ports = get_allocated_ports({ registry_path });
                const port_entry = ports[name];
                if (port_entry) {
                    const ip = spawnSync('hostname', ['-I'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
                    register({ name, ip, port: port_entry.port, namespace_id, region: region || get_instance_metadata().region });
                }
            }

            res.json({ ok: true, name, action: 'started' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs/:name/stop
    router.post('/dbs/:name/stop', (req, res) => {
        try {
            const project_dir = resolve(projects_dir, req.params.name);
            if (!existsSync(project_dir)) {
                return res.status(404).json({ ok: false, error: `Project ${req.params.name} not found` });
            }

            const result = compose_cmd(project_dir, ['down']);
            if (result.status !== 0) {
                return res.status(500).json({ ok: false, error: `stop failed: ${result.stderr}` });
            }
            res.json({ ok: true, name: req.params.name, action: 'stopped' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs/:name/reset — stop, wipe data dir contents, restart
    router.post('/dbs/:name/reset', (req, res) => {
        try {
            const { name } = req.params;
            const project_dir = resolve(projects_dir, name);
            if (!existsSync(project_dir)) {
                return res.status(404).json({ ok: false, error: `Project ${name} not found` });
            }

            // Stop
            compose_cmd(project_dir, ['down']);

            // Wipe data directory contents (keep the mount point)
            const mount_path = resolve(data_dir, name);
            if (existsSync(mount_path)) {
                const entries = readdirSync(mount_path);
                for (const entry of entries) {
                    rmSync(resolve(mount_path, entry), { recursive: true, force: true });
                }
            }

            // Pull fresh seeds from S3 if available
            const seeds_dir = sync_seeds(name);

            // Regenerate compose file with seeds if available
            if (seeds_dir) {
                const ports = get_allocated_ports({ registry_path });
                const port_entry = ports[name];
                if (port_entry) {
                    const compose_content = generate_compose({
                        name,
                        engine: port_entry.engine,
                        port: port_entry.port,
                        db_name: name,
                        data_dir,
                        seeds_dir,
                    });
                    writeFileSync(resolve(project_dir, 'docker-compose.yml'), compose_content);
                }
            }

            // Restart
            const up = compose_cmd(project_dir, ['up', '-d']);
            if (up.status !== 0) {
                return res.status(500).json({ ok: false, error: `restart failed: ${up.stderr}` });
            }
            res.json({ ok: true, name, action: 'reset', seeds: !!seeds_dir });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // GET /dbs/:name/profiles — list available profiles from S3
    router.get('/dbs/:name/profiles', (req, res) => {
        try {
            const { name } = req.params;
            const ports = get_allocated_ports({ registry_path });
            const entry = ports[name];
            if (!entry) {
                return res.status(404).json({ ok: false, error: `DB ${name} not found in registry` });
            }

            const profiles = list_s3_profiles({ name, engine: entry.engine, bucket: SEED_BUCKET });
            const registry = read_profile_registry(data_dir);
            const active = registry[name]?.active || 'default';

            res.json({ ok: true, name, active, profiles });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /dbs/:name/snapshot — dump live DB state to S3
    router.post('/dbs/:name/snapshot', (req, res) => {
        try {
            const { name } = req.params;
            const { profile } = req.body;
            if (!profile) {
                return res.status(400).json({ ok: false, error: 'profile is required' });
            }

            const ports = get_allocated_ports({ registry_path });
            const entry = ports[name];
            if (!entry) {
                return res.status(404).json({ ok: false, error: `DB ${name} not found in registry` });
            }

            const config = get_compose_config(projects_dir, name, entry.engine);
            const result = snapshot_db({
                name,
                profile,
                engine: entry.engine,
                port: entry.port,
                db_name: config.db_name,
                db_user: config.user,
                db_password: config.password,
                bucket: SEED_BUCKET,
                projects_dir,
            });

            res.json({ ok: true, name, profile, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Switch/restore handler (shared by /switch and /restore)
    function handle_switch(req, res) {
        try {
            const { name } = req.params;
            const { profile } = req.body;
            if (!profile) {
                return res.status(400).json({ ok: false, error: 'profile is required' });
            }

            const ports = get_allocated_ports({ registry_path });
            const entry = ports[name];
            if (!entry) {
                return res.status(404).json({ ok: false, error: `DB ${name} not found in registry` });
            }

            const project_dir = resolve(projects_dir, name);
            if (!existsSync(project_dir)) {
                return res.status(404).json({ ok: false, error: `Project ${name} not found` });
            }

            // Stop container
            compose_cmd(project_dir, ['down']);

            // Wipe data directory contents
            const mount_path = resolve(data_dir, name);
            if (existsSync(mount_path)) {
                const entries = readdirSync(mount_path);
                for (const e of entries) {
                    rmSync(resolve(mount_path, e), { recursive: true, force: true });
                }
            }

            // Download profile seed from S3
            const fetched_seeds_dir = download_profile_seed({
                name,
                profile,
                engine: entry.engine,
                bucket: SEED_BUCKET,
                seeds_base: SEEDS_BASE,
            });

            // Regenerate compose with seeds (preserve original db_name)
            const db_name = get_db_name(projects_dir, name, entry.engine);
            const compose_content = generate_compose({
                name,
                engine: entry.engine,
                port: entry.port,
                db_name,
                data_dir,
                seeds_dir: fetched_seeds_dir,
            });
            writeFileSync(resolve(project_dir, 'docker-compose.yml'), compose_content);

            // Start container
            const up = compose_cmd(project_dir, ['up', '-d']);
            if (up.status !== 0) {
                return res.status(500).json({ ok: false, error: `start failed: ${up.stderr}` });
            }

            // Seed directly via docker exec (more reliable than entrypoint initdb)
            const config = get_compose_config(projects_dir, name, entry.engine);
            const container_name = spawnSync('docker', ['compose', 'ps', '--format', '{{.Name}}'], {
                cwd: project_dir, encoding: 'utf8', stdio: 'pipe',
            }).stdout.trim().split('\n')[0] || name;

            seed_after_start({
                container: container_name,
                engine: entry.engine,
                seeds_dir: fetched_seeds_dir,
                profile,
                db_user: config.user,
                db_password: config.password,
            });

            // Update profile registry
            write_active_profile(name, profile, data_dir);

            res.json({ ok: true, name, profile, action: 'switched' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    }

    router.post('/dbs/:name/switch', handle_switch);
    router.post('/dbs/:name/restore', handle_switch);

    // DELETE /dbs/:name — stop, remove project dir, deregister, release port. Keep EBS volume.
    router.delete('/dbs/:name', (req, res) => {
        try {
            const { name } = req.params;
            const project_dir = resolve(projects_dir, name);

            if (existsSync(project_dir)) {
                compose_cmd(project_dir, ['down']);
                rmSync(project_dir, { recursive: true, force: true });
            }

            // Deregister from CloudMap
            if (namespace_id) {
                const meta = get_instance_metadata();
                deregister({
                    name,
                    namespace_id,
                    region: region || meta.region,
                });
            }

            // Release port
            release_port(name, { registry_path });

            const result = { ok: true, name, action: 'deleted' };
            if (on_after_delete) on_after_delete(result);
            res.json(result);
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Health check
    router.get('/health', (req, res) => {
        res.json({ ok: true, service: 'db-host' });
    });

    return router;
}
