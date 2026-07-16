/**
 * soa#327 settle probes — unit tests for `makePersonaPreflight` (the tunnel
 * post-restore devLogin probe) and `makeSettleBarrier` (the pre-bake quiescence
 * gate) with scripted poster/pg-probe fakes + a recorded sleep: retry/poll
 * policy (transport-class only, capped attempts, stability window, poll cap)
 * is asserted without any network, docker, or wall-clock time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDevLoginRequest } from '../../core/login.js';
import type { PostOptions, PostResult } from '../http-post.js';
import type { CookiePoster } from '../http-post.js';
import type { PgProbe } from '../pg-probe.js';
import {
  makePersonaPreflight,
  makeSettleBarrier,
  PREFLIGHT_ATTEMPTS,
  PREFLIGHT_RETRY_DELAY_MS,
  SETTLE_MAX_POLLS,
  SETTLE_POLL_INTERVAL_MS,
} from '../settle-barrier.js';

const REQ = buildDevLoginRequest('alex.tutor@example.org', 'https://iam.moniker.vms.test');

/** Poster answering `statuses` in order (last repeats); records every call. */
function scriptedPoster(statuses: number[]): {
  poster: CookiePoster;
  posts: { url: string; opts: PostOptions }[];
} {
  const posts: { url: string; opts: PostOptions }[] = [];
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      posts.push({ url, opts });
      const status = statuses[Math.min(posts.length - 1, statuses.length - 1)] ?? 0;
      return { status, ok: status >= 200 && status < 300, setCookies: [] };
    },
  };
  return { poster, posts };
}

function harness(statuses: number[]): {
  preflight: ReturnType<typeof makePersonaPreflight>;
  posts: { url: string; opts: PostOptions }[];
  sleeps: number[];
} {
  const { poster, posts } = scriptedPoster(statuses);
  const sleeps: number[] = [];
  const preflight = makePersonaPreflight({
    poster,
    log: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { preflight, posts, sleeps };
}

describe('makePersonaPreflight', () => {
  it('200 on the first attempt: one POST, zero sleeps, posts the exact devLogin request', async () => {
    const { preflight, posts, sleeps } = harness([200]);
    await expect(preflight(REQ)).resolves.toBe(200);
    expect(posts).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(posts[0]!.url).toBe('https://iam.moniker.vms.test/trpc/auth.devLogin');
    // iam's origin-check is load-bearing: Origin must be the iam host itself.
    expect(posts[0]!.opts.origin).toBe('https://iam.moniker.vms.test');
    expect(posts[0]!.opts.body).toContain('alex.tutor@example.org');
  });

  it('transport blips (status 0) are retried at the policy spacing, then the recovery status returns', async () => {
    const { preflight, posts, sleeps } = harness([0, 0, 200]);
    await expect(preflight(REQ)).resolves.toBe(200);
    expect(posts).toHaveLength(3);
    expect(sleeps).toEqual([PREFLIGHT_RETRY_DELAY_MS, PREFLIGHT_RETRY_DELAY_MS]);
  });

  it('5xx is transport-class too (proxy/service hiccup): retried, recovery wins', async () => {
    const { preflight, posts } = harness([503, 200]);
    await expect(preflight(REQ)).resolves.toBe(200);
    expect(posts).toHaveLength(2);
  });

  it('persistent status 0 exhausts the cap and returns 0 (the caller raises the verdict)', async () => {
    const { preflight, posts } = harness([0]);
    await expect(preflight(REQ)).resolves.toBe(0);
    // Literal, not the imported constant: this test PINS the cap's absolute
    // value (a constant-relative assertion would pass for any cap).
    expect(PREFLIGHT_ATTEMPTS).toBe(3);
    expect(posts).toHaveLength(3);
  });

  it('401 is an ANSWER, not a blip: returned immediately with no retry (it IS the torn verdict)', async () => {
    const { preflight, posts, sleeps } = harness([401]);
    await expect(preflight(REQ)).resolves.toBe(401);
    expect(posts).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('403 (devLogin disabled) is likewise returned immediately', async () => {
    const { preflight, posts } = harness([403, 200]);
    await expect(preflight(REQ)).resolves.toBe(403);
    expect(posts).toHaveLength(1);
  });
});

// ── makeSettleBarrier ────────────────────────────────────────────────────────

/** Per-signal scripted sequences (index by sample ordinal; last value repeats). */
interface BarrierScript {
  users: string[];
  pii: string[];
  outbox: string[];
  loginStatuses: number[];
}

interface BarrierHarness {
  run: () => Promise<void>;
  scalarCalls: { container: string; db: string; sql: string }[];
  loginPosts: { url: string; opts: PostOptions }[];
  sleeps: number[];
  logged: string[];
}

function barrierHarness(script: BarrierScript, opts: { slot?: number; personas?: string[] } = {}): BarrierHarness {
  const scalarCalls: { container: string; db: string; sql: string }[] = [];
  const at = (seq: string[], i: number): string => seq[Math.min(i, seq.length - 1)] ?? '';
  let usersN = 0;
  let piiN = 0;
  let outboxN = 0;
  const probe: PgProbe = {
    async databaseExists() { return true; },
    async hasMigrationsTable() { return false; },
    async publicTableCount() { return 0; },
    async scalar(container, db, sql) {
      scalarCalls.push({ container, db, sql });
      if (sql.includes('outbox_event')) return at(script.outbox, outboxN++);
      if (db === 'iam_pii_local') return at(script.pii, piiN++);
      return at(script.users, usersN++);
    },
  };
  const loginPosts: { url: string; opts: PostOptions }[] = [];
  const poster: CookiePoster = {
    async post(url, popts): Promise<PostResult> {
      loginPosts.push({ url, opts: popts });
      const status = script.loginStatuses[Math.min(loginPosts.length - 1, script.loginStatuses.length - 1)] ?? 0;
      return { status, ok: status === 200, setCookies: [] };
    },
  };
  const sleeps: number[] = [];
  const logged: string[] = [];
  const barrier = makeSettleBarrier({
    probe,
    poster,
    log: (l) => logged.push(l),
    ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const run = (): Promise<void> =>
    barrier({
      fixtureId: 'flow-saga-dash-journey-s1-roster',
      stageId: 'roster',
      personas: opts.personas ?? ['alex.tutor@example.org'],
    });
  return { run, scalarCalls, loginPosts, sleeps, logged };
}

describe('makeSettleBarrier', () => {
  beforeEach(() => {
    process.env.SAGA_MESH_POSTGRES_CONTAINER = 'test-postgres';
  });
  afterEach(() => {
    delete process.env.SAGA_MESH_POSTGRES_CONTAINER;
  });

  it('fast path: stable counts + outbox 0 + devLogin 200 settles on the FIRST poll', async () => {
    const h = barrierHarness({ users: ['259'], pii: ['41'], outbox: ['0'], loginStatuses: [200] });
    await expect(h.run()).resolves.toBeUndefined();
    // Two samples (baseline + poll 1), one poll interval slept, one devLogin.
    expect(h.sleeps).toEqual([SETTLE_POLL_INTERVAL_MS]);
    expect(h.loginPosts).toHaveLength(1);
    // The probes hit the CALL-TIME container (env contract) and the iam DBs.
    expect(h.scalarCalls.every((c) => c.container === 'test-postgres')).toBe(true);
    expect(h.scalarCalls.some((c) => c.db === 'iam_pii_local' && c.sql.includes('user_pii'))).toBe(true);
    expect(h.scalarCalls.some((c) => c.db === 'iam_local' && c.sql.includes('outbox_event'))).toBe(true);
  });

  it('moving pii counts RESET the stability window; settles once two consecutive samples agree', async () => {
    // Samples: baseline 41 → 80 (moved) → 121 (moved) → 121 (stable ⇒ settle).
    const h = barrierHarness({ users: ['339'], pii: ['41', '80', '121', '121'], outbox: ['0'], loginStatuses: [200] });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.sleeps).toHaveLength(3); // three polls until the pair repeated
    expect(h.loginPosts).toHaveLength(1); // devLogin only probed once counts settled
  });

  it('an UNDRAINED outbox blocks settling even with stable counts', async () => {
    // outbox: 200 unpublished on poll 1, drained on poll 2.
    const h = barrierHarness({ users: ['339'], pii: ['121'], outbox: ['200', '200', '0'], loginStatuses: [200] });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.sleeps).toHaveLength(2);
  });

  it('devLogin non-200 keeps polling until the persona can actually log in', async () => {
    const h = barrierHarness({ users: ['339'], pii: ['121'], outbox: ['0'], loginStatuses: [401, 401, 200] });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.loginPosts).toHaveLength(3);
  });

  it('the devLogin probe is slot-aware (slot 2 ⇒ iam at :5010) with iam’s own origin', async () => {
    const h = barrierHarness({ users: ['1'], pii: ['1'], outbox: ['0'], loginStatuses: [200] }, { slot: 2 });
    await h.run();
    expect(h.loginPosts[0]!.url).toBe('http://localhost:5010/trpc/auth.devLogin');
    expect(h.loginPosts[0]!.opts.origin).toBe('http://localhost:5010');
    expect(h.loginPosts[0]!.opts.body).toContain('alex.tutor@example.org');
  });

  it('never settling THROWS at the poll cap, naming the fixture + last signal (never bakes torn)', async () => {
    const h = barrierHarness({ users: ['339'], pii: ['121'], outbox: ['7'], loginStatuses: [200] });
    await expect(h.run()).rejects.toThrow(
      /settle barrier TIMED OUT[\s\S]*flow-saga-dash-journey-s1-roster[\s\S]*outbox_unpublished=7/,
    );
    expect(h.sleeps).toHaveLength(SETTLE_MAX_POLLS); // the cap is a POLL COUNT (fake-sleep safe)
  });

  it("a probe error ('' scalar) never reads as stable — '' === '' must not pass the bar", async () => {
    const h = barrierHarness({ users: [''], pii: [''], outbox: ['0'], loginStatuses: [200] });
    await expect(h.run()).rejects.toThrow(/TIMED OUT/);
    expect(h.loginPosts).toHaveLength(0); // devLogin never probed while counts are unreadable
  });

  it('EVERY declared persona must devLogin 200 (one failing blocks settling)', async () => {
    // Two personas: the first always 200, the second 401 then 200.
    const h = barrierHarness(
      { users: ['1'], pii: ['1'], outbox: ['0'], loginStatuses: [200, 401, 200, 200] },
      { personas: ['alex.tutor@example.org', 'ann.lee@example.org'] },
    );
    await expect(h.run()).resolves.toBeUndefined();
    // Poll 1: alex 200, ann 401 ⇒ not settled. Poll 2: alex 200, ann 200 ⇒ settled.
    expect(h.loginPosts).toHaveLength(4);
    expect(h.loginPosts[1]!.opts.body).toContain('ann.lee@example.org');
  });
});
