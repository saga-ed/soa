import { describe, expect, it } from 'vitest';
import { localCookies, optionsFrom, runTraffic } from './synthetic-traffic.mjs';

const jar = '#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tiam_session\ttest-session';
const response = data => ({ ok: true, status: 200, json: async () => ({ result: { data } }) });
const dependencies = fetchImpl => ({
  fetchImpl,
  readJar: async () => jar,
  sleep: async () => {},
  emit: () => {},
});

describe('bounded synthetic traffic', () => {
  it('rejects missing slots, unknown profiles and out-of-bounds load', () => {
    for (const options of [
      {},
      { slot: '10' },
      { slot: '3', profile: 'toString' },
      { slot: '3', concurrency: '9' },
      { slot: '3', interval: '0' },
      { slot: '3', requests: '10001' },
      { slot: '3', duration: '601' },
    ]) {
      expect(() => optionsFrom(options)).toThrow();
    }
  });

  it('discards remote, secure, expired and unrelated-path cookies', () => {
    const cookies = [
      jar,
      'example.org\tFALSE\t/\tFALSE\t0\tiam_session\tremote',
      'localhost\tFALSE\t/\tTRUE\t0\tiam_session\tsecure',
      'localhost\tFALSE\t/\tFALSE\t1\tiam_session\texpired',
      'localhost\tFALSE\t/admin\tFALSE\t0\tiam_session\tother-path',
    ];
    expect(localCookies(cookies.join('\n'), 2000)).toBe('iam_session=test-session');
  });

  it('shares an exact request cap across workers and uses only fixed loopback GET routes', async () => {
    const calls = [];
    const summary = await runTraffic(
      optionsFrom({ slot: '3', profile: 'burst', requests: '14' }),
      dependencies(async (url, init) => {
        calls.push({ url, init });
        return response(
          url.pathname.endsWith('programs.list') ? { programs: [{ id: 'existing-program' }] } : {}
        );
      })
    );
    expect(calls).toHaveLength(14);
    expect(summary.stopReason).toBe('request-limit');
    expect(summary.errors).toEqual([]);
    expect(
      summary.endpoints.filter(row => row.phase === 'workload').map(row => row.requests)
    ).toEqual([3, 3, 3, 3]);
    for (const { url, init } of calls) {
      expect(url.hostname).toBe('localhost');
      expect(['6010', '6006', '6008']).toContain(url.port);
      expect([
        '/trpc/auth.whoami',
        '/trpc/programs.list',
        '/trpc/programs.get',
        '/trpc/schedules.get',
      ]).toContain(url.pathname);
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
    }
  });

  it('stops after failure and does not print sensitive upstream errors', async () => {
    let calls = 0;
    const messages = [];
    const summary = await runTraffic(optionsFrom({ slot: '3', requests: '20' }), {
      ...dependencies(async url => {
        calls++;
        if (calls === 3) throw new Error('secret-session-and-url');
        return response(
          url.pathname.endsWith('programs.list') ? { programs: [{ id: 'private-id' }] } : {}
        );
      }),
      emit: value => messages.push(value),
    });
    expect(calls).toBe(3);
    expect(summary.stopReason).toBe('failure');
    expect(summary.endpoints.at(-1).failures).toBe(1);
    expect(messages.join('')).not.toMatch(/secret-session|private-id|test-session/);
  });

  it('does not synthesize data when the prepared slot has no programs', async () => {
    let calls = 0;
    const summary = await runTraffic(
      optionsFrom({ slot: '3' }),
      dependencies(async () => {
        calls++;
        return response({ programs: [] });
      })
    );
    expect(calls).toBe(2);
    expect(summary.stopReason).toBe('failure');
    expect(summary.workloadStartedAt).toBeNull();
  });

  it('stops scheduling when interrupted during the workload', async () => {
    const controller = new AbortController();
    let calls = 0;
    const summary = await runTraffic(optionsFrom({ slot: '3', requests: '20' }), {
      ...dependencies(async url => {
        calls++;
        return response(
          url.pathname.endsWith('programs.list') ? { programs: [{ id: 'existing' }] } : {}
        );
      }),
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(calls).toBe(3);
    expect(summary.stopReason).toBe('interrupted');
  });

  it('creates the documented program-heavy mix with an exact shared budget', async () => {
    const summary = await runTraffic(
      optionsFrom({ slot: '3', profile: 'mixed', requests: '18' }),
      dependencies(async url =>
        response(url.pathname.endsWith('programs.list') ? { programs: [{ id: 'existing' }] } : {})
      )
    );
    const counts = Object.fromEntries(
      summary.endpoints
        .filter(row => row.phase === 'workload')
        .map(row => [row.procedure, row.requests])
    );
    expect(counts).toEqual({
      'programs.list': 8,
      'programs.get': 4,
      'schedules.get': 2,
      'auth.whoami': 2,
    });
  });
});
