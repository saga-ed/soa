import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generate_compose } from '../../src/ec2/compose-generator.js';

describe('generate_compose resource limits', () => {
    const base = {
        name: 'pr-42',
        port: 5433,
        db_name: 'pr_42',
        data_dir: '/mnt/data',
    };

    const saved_env = {};
    beforeEach(() => {
        for (const k of ['DB_HOST_POSTGRES_MEM_LIMIT', 'DB_HOST_POSTGRES_CPUS',
            'DB_HOST_MYSQL_MEM_LIMIT', 'DB_HOST_MYSQL_CPUS',
            'DB_HOST_MONGO_MEM_LIMIT', 'DB_HOST_MONGO_CPUS']) {
            saved_env[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved_env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('emits per-engine defaults for postgres', () => {
        const out = generate_compose({ ...base, engine: 'postgres' });
        expect(out).toMatch(/mem_limit: 1g/);
        expect(out).toMatch(/cpus: 1\.0/);
    });

    it('emits per-engine defaults for mysql', () => {
        const out = generate_compose({ ...base, engine: 'mysql', port: 3307 });
        expect(out).toMatch(/mem_limit: 1g/);
        expect(out).toMatch(/cpus: 1\.0/);
    });

    it('emits per-engine defaults for mongo (1536m)', () => {
        const out = generate_compose({ ...base, engine: 'mongo', port: 27018 });
        expect(out).toMatch(/mem_limit: 1536m/);
        expect(out).toMatch(/cpus: 1\.0/);
    });

    it('explicit resources override defaults', () => {
        const out = generate_compose({
            ...base, engine: 'postgres',
            resources: { mem_limit: '2g', cpus: '2.0' },
        });
        expect(out).toMatch(/mem_limit: 2g/);
        expect(out).toMatch(/cpus: 2\.0/);
        expect(out).not.toMatch(/mem_limit: 1g/);
    });

    it('env vars override defaults but not explicit config', () => {
        process.env.DB_HOST_POSTGRES_MEM_LIMIT = '3g';
        process.env.DB_HOST_POSTGRES_CPUS = '1.5';
        const out_env = generate_compose({ ...base, engine: 'postgres' });
        expect(out_env).toMatch(/mem_limit: 3g/);
        expect(out_env).toMatch(/cpus: 1\.5/);

        const out_explicit = generate_compose({
            ...base, engine: 'postgres',
            resources: { mem_limit: '500m' },
        });
        expect(out_explicit).toMatch(/mem_limit: 500m/);
        // cpus falls through to env when not in explicit override
        expect(out_explicit).toMatch(/cpus: 1\.5/);
    });

    it('still produces a valid-looking compose YAML structure', () => {
        const out = generate_compose({ ...base, engine: 'postgres' });
        expect(out).toMatch(/^services:/m);
        expect(out).toMatch(/image: postgres:18/);
        expect(out).toMatch(/container_name: pr-42/);
        expect(out).toMatch(/"5433:5432"/);
    });
});
