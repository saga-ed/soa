/**
 * `TUNNEL_SERVICE_LABELS` drift guard (Tunnel Mode, saga-ed/soa#298).
 *
 * `e2e run --tunnel` re-points each `PLAYWRIGHT_*_URL` at `https://<label>.<domain>`,
 * where `<label>` is the vendored `tunnel.sh` SERVICES key. The label is NOT
 * string-derivable from the ServiceId (`saga-dash→dash`, `connect-web→connect`,
 * `ads-adm-api→ads-adm` are renames; most `-api` ids drop the suffix but
 * `connect-api` keeps it), so it lives in an explicit `TUNNEL_SERVICE_LABELS` table.
 *
 * Two ways that table can rot, both caught here:
 *   1. a NEW `PLAYWRIGHT_SERVICE_URL_ENV` ServiceId lands with no label → its tunnel
 *      URL would be silently dropped (localhost leaks to the remote browser);
 *   2. a label drifts from the vendored `tunnel.sh` SERVICES table → the frpc host
 *      never exists and the browser 502s.
 *
 * So: every URL-env ServiceId must have a label, and every label must be a REAL
 * `vendor/tunnel.sh` SERVICES entry (parsed from the vendored script, cwd-independent).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_SERVICE_URL_ENV, TUNNEL_SERVICE_LABELS } from '../e2e-orchestrate.js';
import { COACH_WEB_TUNNEL_LABELS } from '../runtime/coach-web-env.js';

/** Walk UP from `start` to the first ancestor for which `join(dir, ...rel)` exists. */
function findUp(start: string, rel: string[]): string {
    let dir = start;
    for (let i = 0; i < 12; i++) {
        const candidate = join(dir, ...rel);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`tunnel-service-labels: could not locate ${rel.join('/')} walking up from ${start}`);
}

/** Parse the `SERVICES=( "label:port" … )` array out of the vendored tunnel.sh. */
function tunnelServiceLabels(): Set<string> {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(findUp(here, ['vendor', 'tunnel.sh']), 'utf8');
    const block = script.match(/SERVICES=\(([\s\S]*?)\)/);
    if (!block) throw new Error('tunnel-service-labels: could not find SERVICES=( … ) in vendor/tunnel.sh');
    const labels = new Set<string>();
    for (const m of block[1].matchAll(/"([^":]+):\d+"/g)) labels.add(m[1]);
    return labels;
}

describe('TUNNEL_SERVICE_LABELS ↔ PLAYWRIGHT_SERVICE_URL_ENV ↔ vendor/tunnel.sh', () => {
    const vendorLabels = tunnelServiceLabels();

    it('sanity: the vendored SERVICES parse yields the known tunnel hosts', () => {
        // A guard on the parser itself — if this shrinks to 0 the coverage below is vacuous.
        expect(vendorLabels.size).toBeGreaterThanOrEqual(9);
        expect(vendorLabels).toContain('dash');
        expect(vendorLabels).toContain('connect-api');
    });

    it('every PLAYWRIGHT_SERVICE_URL_ENV ServiceId has a TUNNEL_SERVICE_LABELS entry', () => {
        for (const svc of Object.values(PLAYWRIGHT_SERVICE_URL_ENV)) {
            expect(TUNNEL_SERVICE_LABELS[svc], `no tunnel label for ServiceId '${svc}'`).toBeDefined();
        }
    });

    it('every mapped label is a REAL vendor/tunnel.sh SERVICES entry (no phantom hosts)', () => {
        for (const svc of Object.values(PLAYWRIGHT_SERVICE_URL_ENV)) {
            const label = TUNNEL_SERVICE_LABELS[svc];
            expect(vendorLabels.has(label), `label '${label}' (for '${svc}') is not a tunnel.sh SERVICES entry`).toBe(true);
        }
    });

    it('pins the non-derivable renames (the trap this table exists to prevent)', () => {
        // saga-dash→dash / connect-web→connect / ads-adm-api→ads-adm are renames, and
        // connect-api KEEPS its -api suffix while the other -api ids drop it.
        expect(TUNNEL_SERVICE_LABELS['saga-dash']).toBe('dash');
        expect(TUNNEL_SERVICE_LABELS['connect-web']).toBe('connect');
        expect(TUNNEL_SERVICE_LABELS['ads-adm-api']).toBe('ads-adm');
        expect(TUNNEL_SERVICE_LABELS['connect-api']).toBe('connect-api');
        expect(TUNNEL_SERVICE_LABELS['iam-api']).toBe('iam');
    });
});

/**
 * The same drift risk, for the coach-web `.env.local` writer (soa#298).
 *
 * `COACH_WEB_TUNNEL_LABELS` is a SECOND label table — deliberately separate, because
 * the one above serves `PLAYWRIGHT_*_URL` for the e2e lane and carries no coach
 * entries. Both must stay pinned to the same vendored source of truth, so a
 * re-vendored `tunnel.sh` that renames a host fails HERE rather than 502-ing a
 * remote coworker's browser.
 */
describe('COACH_WEB_TUNNEL_LABELS ↔ vendor/tunnel.sh (soa#298)', () => {
    const vendorLabels = tunnelServiceLabels();

    it('every coach-web label is a REAL vendor/tunnel.sh SERVICES entry (no phantom hosts)', () => {
        for (const [svc, label] of Object.entries(COACH_WEB_TUNNEL_LABELS)) {
            expect(
                vendorLabels.has(label as string),
                `label '${label}' (for '${svc}') is not a tunnel.sh SERVICES entry`,
            ).toBe(true);
        }
    });

    it('covers every service coach-web dials, and pins the non-derivable names', () => {
        // These three back the four PUBLIC_* vars coach-web reads at vite-dev time
        // (PUBLIC_LOGIN_URL points at iam — tunnel.sh has no `login` host).
        expect(COACH_WEB_TUNNEL_LABELS['iam-api']).toBe('iam');
        expect(COACH_WEB_TUNNEL_LABELS['saga-dash']).toBe('dash'); // rename
        expect(COACH_WEB_TUNNEL_LABELS['coach-api']).toBe('coach-api'); // keeps -api, unlike iam-api
    });

    it('agrees with TUNNEL_SERVICE_LABELS wherever the two tables overlap', () => {
        // Two tables, one truth: if they ever disagree on a shared service, one lane is
        // pointing at the wrong host.
        for (const [svc, label] of Object.entries(COACH_WEB_TUNNEL_LABELS)) {
            const shared = TUNNEL_SERVICE_LABELS[svc as keyof typeof TUNNEL_SERVICE_LABELS];
            if (shared !== undefined) expect(shared, `tables disagree on '${svc}'`).toBe(label);
        }
    });
});
