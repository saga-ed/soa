/**
 * soa#327 settle probes — unit tests for `makePersonaPreflight` (the tunnel
 * post-restore devLogin probe) with a scripted poster + recorded sleep: the
 * retry policy (transport-class only, capped attempts, fixed spacing) is
 * asserted without any network or wall-clock time.
 */

import { describe, expect, it } from 'vitest';
import { buildDevLoginRequest } from '../../core/login.js';
import type { PostOptions, PostResult } from '../http-post.js';
import type { CookiePoster } from '../http-post.js';
import {
  makePersonaPreflight,
  PREFLIGHT_ATTEMPTS,
  PREFLIGHT_RETRY_DELAY_MS,
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
    expect(posts).toHaveLength(PREFLIGHT_ATTEMPTS);
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
