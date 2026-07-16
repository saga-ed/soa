/**
 * soa#327 tunnel fail-loud — unit tests for the PURE message builder the
 * prerequisite-restore gate raises under `--tunnel` instead of the local lane's
 * silent warn+full-replay. The message IS the remediation: it must embed the
 * original violation verbatim plus the docs/tunnel.md concierge recipe and both
 * checkpoint escape hatches (`--refresh-snapshot` for develop connect, which has
 * no --from-stale-ok flag; `--from-stale-ok` for e2e run).
 */

import { describe, expect, it } from 'vitest';
import { tunnelPrereqFallbackMessage } from '../e2e-orchestrate.js';

describe('tunnelPrereqFallbackMessage', () => {
  it('embeds the original violation verbatim so the remediation is exact', () => {
    const msg = tunnelPrereqFallbackMessage("no checkpoint 'flow-saga-dash-journey-s5-schedule'");
    expect(msg).toContain("no checkpoint 'flow-saga-dash-journey-s5-schedule'");
  });

  it('carries the full docs/tunnel.md concierge recipe, in order', () => {
    const msg = tunnelPrereqFallbackMessage('x');
    const recipe = [
      'ss stack down && ss stack up --seed full --reset',
      'ss e2e run journey --through schedule',
      'ss stack snapshot store --fixture-id tunnel-connect',
      'ss stack down && ss stack up --tunnel --reset',
      'ss stack snapshot restore tunnel-connect',
      'ss develop connect --tunnel --student-login 1 --reuse',
    ];
    let cursor = -1;
    for (const line of recipe) {
      const at = msg.indexOf(line);
      expect(at, `recipe line missing or out of order: ${line}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('names BOTH escape hatches — --refresh-snapshot (develop connect) and --from-stale-ok (e2e run only)', () => {
    const msg = tunnelPrereqFallbackMessage('checkpoint is 9 days old');
    // develop connect has NO --from-stale-ok flag, so the message must offer its
    // own re-bake (--refresh-snapshot) and scope --from-stale-ok to e2e run.
    expect(msg).toContain('--refresh-snapshot');
    expect(msg).toMatch(/--from-stale-ok.*e2e run only/);
  });

  it('says it is refusing the silent fallback (the WHY)', () => {
    expect(tunnelPrereqFallbackMessage('x')).toMatch(/refusing to fall back silently/);
  });
});
