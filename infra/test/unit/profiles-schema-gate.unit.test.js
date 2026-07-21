import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two spawnSync surfaces to stub: the sidecar `aws s3 cp <src> -` download
// (piped straight to stdout, no /tmp file — see check_schema_rev_gate), and
// the `_prisma_migrations` rev query (docker exec psql) against the CURRENT db.
const spawnSync_calls = [];
let sidecarCpResult = { status: 0, stdout: '', stderr: '' };
let revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };

function isSidecarCp(cmd, args) {
    return cmd === 'aws' && args[0] === 's3' && args[1] === 'cp' && args[3] === '-';
}
function isRevQuery(cmd, args) {
    return cmd === 'docker' && args[0] === 'exec' && args.includes('psql')
        && args.some((a) => typeof a === 'string' && a.includes('_prisma_migrations'));
}
function isInspectRunning(cmd, args) {
    return cmd === 'docker' && args[0] === 'inspect' && args.includes('{{.State.Running}}');
}

let containerRunning = true;

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        if (isSidecarCp(cmd, args)) return sidecarCpResult;
        if (isRevQuery(cmd, args)) return revQueryResult;
        if (isInspectRunning(cmd, args)) return { status: 0, stdout: containerRunning ? 'true\n' : 'false\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

import { check_schema_rev_gate, SCHEMA_GATE_VERDICTS } from '../../src/ec2/profiles.js';

const BASE = {
    name: 'programs-api-sbx',
    profile: 'canonical',
    bucket: 'seeds-bkt',
    mode: 'enforce',
    container: 'sbx-db-1',
    db_name: 'programs',
    db_user: 'postgres_admin',
};

function setSidecar(schemaRev) {
    sidecarCpResult = { status: 0, stdout: JSON.stringify({ schemaRev }), stderr: '' };
}
function setNoSidecar() {
    sidecarCpResult = { status: 1, stdout: '', stderr: 'NoSuchKey' };
}
function setDbHead(rev) {
    revQueryResult = rev === null
        ? { status: 1, stdout: '', stderr: 'relation "_prisma_migrations" does not exist' }
        : { status: 0, stdout: `${rev}\n`, stderr: '' };
}

describe('check_schema_rev_gate', () => {
    beforeEach(() => {
        spawnSync_calls.length = 0;
        containerRunning = true;
        setSidecar('20260603120000_add_session_index');
        setDbHead('20260603120000_add_session_index');
    });

    it('verdict=clean when sidecar schemaRev matches the current DB head', () => {
        const gate = check_schema_rev_gate({ ...BASE });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.CLEAN);
        expect(gate.refuse).toBe(false);
        expect(gate.snapshotSchemaRev).toBe('20260603120000_add_session_index');
        expect(gate.dbSchemaRev).toBe('20260603120000_add_session_index');
    });

    it('verdict=ahead + refuses in enforce when sidecar is ahead of DB head', () => {
        setSidecar('20260701000000_later_migration');
        setDbHead('20260603120000_add_session_index');
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.AHEAD);
        expect(gate.refuse).toBe(true);
        expect(gate.message).toMatch(/ahead of DB head/);
        expect(gate.message).toMatch(/rollback not supported/);
    });

    it('verdict=behind + refuses in enforce when sidecar is behind DB head', () => {
        setSidecar('20260101000000_old_migration');
        setDbHead('20260603120000_add_session_index');
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.BEHIND);
        expect(gate.refuse).toBe(true);
        expect(gate.message).toMatch(/behind DB head/);
        expect(gate.message).toMatch(/auto-heal is not enabled/);
    });

    it('verdict=no-sidecar + refuses in enforce when the sidecar is missing', () => {
        setNoSidecar();
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.NO_SIDECAR);
        expect(gate.refuse).toBe(true);
        expect(gate.snapshotSchemaRev).toBeNull();
    });

    it('treats a null schemaRev inside an otherwise-present sidecar like no-sidecar', () => {
        setSidecar(null);
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.NO_SIDECAR);
        expect(gate.refuse).toBe(true);
    });

    it('verdict=unverified-fresh-db and always proceeds when the current DB has no applied migrations', () => {
        setDbHead(null);
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.UNVERIFIED_FRESH_DB);
        expect(gate.refuse).toBe(false);
        expect(gate.dbSchemaRev).toBeNull();
        expect(gate.message).toMatch(/fresh provision/);
    });

    it('same unverified-fresh-db verdict/proceed behavior, but a distinct log message, when the container is unreachable rather than genuinely fresh', () => {
        setDbHead(null);
        containerRunning = false;
        const gate = check_schema_rev_gate({ ...BASE, mode: 'enforce' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.UNVERIFIED_FRESH_DB);
        expect(gate.refuse).toBe(false);
        expect(gate.message).toMatch(/unreachable\/stopped/);
        expect(gate.message).not.toMatch(/fresh provision/);
    });

    it('mode=off never refuses, regardless of verdict', () => {
        setSidecar('20260701000000_later_migration'); // ahead
        setDbHead('20260603120000_add_session_index');
        const gate = check_schema_rev_gate({ ...BASE, mode: 'off' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.AHEAD);
        expect(gate.refuse).toBe(false);
    });

    it('mode=warn logs the verdict but never refuses', () => {
        setNoSidecar();
        const gate = check_schema_rev_gate({ ...BASE, mode: 'warn' });
        expect(gate.verdict).toBe(SCHEMA_GATE_VERDICTS.NO_SIDECAR);
        expect(gate.refuse).toBe(false);
    });

    it('resolves the versioned sidecar object when profile carries an @vN pin', () => {
        check_schema_rev_gate({ ...BASE, profile: 'canonical@v2' });
        const cp = spawnSync_calls.find(([cmd, args]) => isSidecarCp(cmd, args));
        expect(cp[1][2]).toBe('s3://seeds-bkt/programs-api-sbx/profile-canonical-v2.meta.json');
    });

    it('reads the sidecar from the seedFrom source prefix, same resolution as the dump', () => {
        check_schema_rev_gate({ ...BASE, source_name: 'programs-api-canonical' });
        const cp = spawnSync_calls.find(([cmd, args]) => isSidecarCp(cmd, args));
        expect(cp[1][2]).toBe('s3://seeds-bkt/programs-api-canonical/profile-canonical.meta.json');
    });
});
