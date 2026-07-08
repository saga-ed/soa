/**
 * `describeUpFailure` — the pure phase-attribution behind `stack up`'s failure line.
 *
 * Regression for the soa cheatsheet diagnosis: a native-prep-pass failure (R1 build/install
 * → R2 provision → R3 migrate) returns `ok:false` with NO `failedAt`, and used to fall through
 * to the launch branch and misreport as `service launch FAILED at (unknown)`. These tests pin
 * that each phase now names the real culprit, and that the mesh + genuine-launch branches are
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
import { describeUpFailure, type UpFailureView } from '../up.js';

/** A healthy mesh (no conflicts, make ok, all units ready) — the common prefix of the deeper phases. */
const okMesh: UpFailureView['mesh'] = {
    conflicts: [],
    makeOk: true,
    units: [
        { id: 'postgres', ok: true },
        { id: 'redis', ok: true },
    ],
};

describe('describeUpFailure — mesh phase', () => {
    it('reports host port conflicts, one ✗ line each', () => {
        const lines = describeUpFailure({
            mesh: { conflicts: [{ message: 'postgres :5432 in use' }], makeOk: true, units: [] },
        });
        expect(lines).toEqual([
            'mesh preflight FAILED — host port conflicts:',
            '  ✗ postgres :5432 in use',
        ]);
    });

    it('reports a non-zero `make up`', () => {
        const lines = describeUpFailure({ mesh: { conflicts: [], makeOk: false, units: [] } });
        expect(lines).toEqual(['mesh bring-up FAILED (`make up` exited non-zero)']);
    });

    it('names the mesh units that never became ready', () => {
        const lines = describeUpFailure({
            mesh: {
                conflicts: [],
                makeOk: true,
                units: [
                    { id: 'postgres', ok: true },
                    { id: 'rabbitmq', ok: false },
                    { id: 'redis', ok: false },
                ],
            },
        });
        expect(lines).toEqual(['mesh units never became ready: rabbitmq, redis']);
    });
});

describe('describeUpFailure — native prep pass (the (unknown) regression)', () => {
    it('names the failing repo + step for a prep (R1) failure instead of (unknown)', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: { ok: false, failed: { repo: 'SAGA_DASH', kind: 'build', argv: ['build'] } },
        });
        expect(lines).toEqual([
            'prep FAILED — `pnpm build` in SAGA_DASH exited non-zero — see the streamed output above',
        ]);
        expect(lines[0]).not.toContain('(unknown)');
    });

    it('includes the lock holder detail when present', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: {
                ok: false,
                failed: { repo: 'ROSTERING', kind: 'lock', argv: ['install'], detail: 'held by pid 4242' },
            },
        });
        expect(lines).toEqual([
            'prep FAILED — `pnpm install` in ROSTERING (held by pid 4242) exited non-zero — see the streamed output above',
        ]);
    });

    it('falls back to a generic prep line when no failed step is attached', () => {
        const lines = describeUpFailure({ mesh: okMesh, prep: { ok: false } });
        expect(lines).toEqual([
            'prep FAILED — a build/install step exited non-zero; see the streamed output above',
        ]);
    });

    it('names the DB for a provision (R2) failure', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: { ok: true },
            provision: { ok: false, failed: 'sessions' },
        });
        expect(lines).toEqual([
            'DB provision FAILED on sessions — role/database create exited non-zero; see the streamed output above',
        ]);
    });

    it('names the DB for a migrate (R3) failure', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: { ok: true },
            provision: { ok: true },
            migrate: { ok: false, failed: 'iam_local' },
        });
        expect(lines).toEqual([
            'migrate FAILED on iam_local — `prisma migrate` exited non-zero; see the streamed output above',
        ]);
    });

    it('prefers the earliest failing phase (prep) when several are unhealthy', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: { ok: false, failed: { repo: 'PROGRAM_HUB', kind: 'db:generate', argv: ['db:generate'] } },
            provision: { ok: false, failed: 'programs' },
            migrate: { ok: false, failed: 'programs' },
        });
        expect(lines).toEqual([
            'prep FAILED — `pnpm db:generate` in PROGRAM_HUB exited non-zero — see the streamed output above',
        ]);
    });
});

describe('describeUpFailure — launch phase', () => {
    it('names the failed service when a launch wave went unhealthy', () => {
        const lines = describeUpFailure({
            mesh: okMesh,
            prep: { ok: true },
            provision: { ok: true },
            migrate: { ok: true },
            failedAt: 'iam-api',
        });
        expect(lines).toEqual(['service launch FAILED at iam-api — it never became healthy']);
    });

    it('still degrades to (unknown) only for a genuinely unattributed launch failure', () => {
        const lines = describeUpFailure({ mesh: okMesh, prep: { ok: true }, provision: { ok: true }, migrate: { ok: true } });
        expect(lines).toEqual(['service launch FAILED at (unknown) — it never became healthy']);
    });
});
