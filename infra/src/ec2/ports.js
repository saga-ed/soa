/**
 * File-based port registry for the EC2 db-host.
 * Tracks which ports are allocated to which database services.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { engines } from './engines.js';

const DEFAULT_REGISTRY_PATH = '/opt/db-manager/port-registry.json';

function read_registry(registry_path) {
    try {
        return JSON.parse(readFileSync(registry_path, 'utf8'));
    } catch {
        return {};
    }
}

function write_registry(registry_path, data) {
    mkdirSync(dirname(registry_path), { recursive: true });
    const tmp = `${registry_path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, registry_path);
}

/**
 * Allocate a port for a named service.
 * @param {string} engine - postgres, mongo, or mysql
 * @param {string} name - service name
 * @param {{ registry_path?: string }} [options]
 * @returns {number} allocated port
 */
export function allocate_port(engine, name, options = {}) {
    const registry_path = options.registry_path || DEFAULT_REGISTRY_PATH;
    const registry = read_registry(registry_path);

    if (registry[name]) return registry[name].port;

    const eng = engines[engine];
    if (!eng) throw new Error(`Unknown engine: ${engine}`);

    const [start, end] = eng.port_range;
    const used_ports = new Set(Object.values(registry).map(e => e.port));

    // Also scan Docker for host ports in use (catches manually-created DBs)
    try {
        const result = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8', stdio: 'pipe' });
        if (result.stdout) {
            for (const line of result.stdout.split('\n')) {
                const matches = line.matchAll(/0\.0\.0\.0:(\d+)->/g);
                for (const m of matches) used_ports.add(Number(m[1]));
            }
        }
    } catch { /* Docker not available, rely on registry only */ }

    for (let port = start; port <= end; port++) {
        if (!used_ports.has(port)) {
            registry[name] = { engine, port };
            write_registry(registry_path, registry);
            return port;
        }
    }

    throw new Error(`No available ports in range ${start}-${end} for engine ${engine}`);
}

/**
 * Record a known (engine, name, port) tuple in the registry. Used during
 * hydrate when the caller already knows which port to use (from a remote
 * source of truth, e.g. the orchestrator's DynamoDB registry) and wants
 * the local port-registry to reflect it without searching for a free slot.
 * @param {string} engine - postgres, mongo, or mysql
 * @param {string} name - service name
 * @param {number} port - port to record
 * @param {{ registry_path?: string }} [options]
 */
export function register_port(engine, name, port, options = {}) {
    const registry_path = options.registry_path || DEFAULT_REGISTRY_PATH;
    const registry = read_registry(registry_path);
    registry[name] = { engine, port };
    write_registry(registry_path, registry);
}

/**
 * Release a port allocation.
 * @param {string} name - service name
 * @param {{ registry_path?: string }} [options]
 */
export function release_port(name, options = {}) {
    const registry_path = options.registry_path || DEFAULT_REGISTRY_PATH;
    const registry = read_registry(registry_path);
    delete registry[name];
    write_registry(registry_path, registry);
}

/**
 * Get all allocated ports.
 * @param {{ registry_path?: string }} [options]
 * @returns {Record<string, { engine: string, port: number }>}
 */
export function get_allocated_ports(options = {}) {
    const registry_path = options.registry_path || DEFAULT_REGISTRY_PATH;
    return read_registry(registry_path);
}
