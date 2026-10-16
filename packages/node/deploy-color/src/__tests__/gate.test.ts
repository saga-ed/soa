import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveColorGate, decide, getOwnColor, resolveGate } from '../index.js';

const env = (c: string) => ({ OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=prod,deployment.identifier=${c}` });

describe('getOwnColor', () => {
    it('parses blue/green', () => {
        expect(getOwnColor(env('blue'))).toBe('blue');
        expect(getOwnColor(env('green'))).toBe('green');
    });
    it('is null for main, absent, malformed', () => {
        expect(getOwnColor(env('main'))).toBeNull();
        expect(getOwnColor({})).toBeNull();
        expect(getOwnColor({ OTEL_RESOURCE_ATTRIBUTES: 'garbage' })).toBeNull();
    });
});

describe('decide', () => {
    it.each([
        ['blue', 'blue', true],
        ['blue', 'green', false],
        ['green', 'green', true],
        ['green', 'none', false],
        ['blue', undefined, true],
        ['blue', 'purple', true],
        ['blue', '', true],
        [null, 'green', true],
        ['main', 'green', true],
    ])('own=%s value=%s => %s', (own, value, expected) => {
        expect(decide(own, value).active).toBe(expected);
    });
});

describe('resolveGate', () => {
    const base = { ownColor: 'blue', parameterName: '/p' };
    it('no parameter name => active without reading', async () => {
        const getParameter = vi.fn();
        expect((await resolveGate({ ...base, parameterName: undefined, getParameter })).active).toBe(true);
        expect(getParameter).not.toHaveBeenCalled();
    });
    it('main colour is active without reading', async () => {
        const getParameter = vi.fn();
        expect((await resolveGate({ ...base, ownColor: 'main', getParameter })).active).toBe(true);
        expect(getParameter).not.toHaveBeenCalled();
    });
    it('ParameterNotFound => active', async () => {
        const getParameter = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'ParameterNotFound' }));
        const r = await resolveGate({ ...base, getParameter });
        expect(r.active).toBe(true);
        expect(r.warning).toBeUndefined();
    });
    it('other error => active with warning', async () => {
        const r = await resolveGate({ ...base, getParameter: vi.fn().mockRejectedValue(new Error('boom')) });
        expect(r).toMatchObject({ active: true, warning: 'boom' });
    });
    it('mismatch and none => inactive', async () => {
        expect((await resolveGate({ ...base, getParameter: async () => 'green' })).active).toBe(false);
        expect((await resolveGate({ ...base, getParameter: async () => 'none' })).active).toBe(false);
        expect((await resolveGate({ ...base, getParameter: async () => 'blue' })).active).toBe(true);
    });
});

describe('createActiveColorGate', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const mk = (getParameter: (n: string) => Promise<string | undefined>, extra = {}) =>
        createActiveColorGate({ getParameter, parameterName: '/p', ownColor: 'blue', random: () => 0.5, ...extra });

    it('is active and never reads when disabled (no param / non blue-green)', async () => {
        const get = vi.fn(async () => 'green');
        const noParam = createActiveColorGate({ getParameter: get, ownColor: 'blue', env: {} });
        const mainColour = mk(get, { ownColor: 'main' });
        await noParam.start();
        await mainColour.start();
        expect(noParam.isActive() && mainColour.isActive()).toBe(true);
        expect(get).not.toHaveBeenCalled();
    });

    it('reads the param name from env.ACTIVE_COLOR_PARAM by default', async () => {
        const get = vi.fn(async () => 'blue');
        const g = createActiveColorGate({ getParameter: get, env: { ...env('blue'), ACTIVE_COLOR_PARAM: '/prod/bluegreen/x/active-color' } });
        await g.start();
        g.stop();
        expect(get).toHaveBeenCalledWith('/prod/bluegreen/x/active-color');
    });

    it('boot read sets state; change fires only on transitions', async () => {
        let v: string | undefined = 'green';
        const g = mk(async () => v);
        const seen: Array<[boolean, string | undefined]> = [];
        g.on('change', (a, val) => seen.push([a, val]));
        await g.start();
        expect(g.isActive()).toBe(false);
        expect(seen).toEqual([[false, 'green']]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen).toHaveLength(1);
        v = 'blue';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(g.isActive()).toBe(true);
        expect(seen[1]).toEqual([true, 'blue']);
        v = 'none';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen[2]).toEqual([false, 'none']);
        g.stop();
    });

    it('keeps last value on transient error and marks stale', async () => {
        let fail = false;
        const warn = vi.fn();
        const g = mk(async () => {
            if (fail) throw new Error('throttled');
            return 'green';
        }, { logger: { info: () => {}, warn } });
        await g.start();
        expect(g.isActive()).toBe(false);
        fail = true;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(g.isActive()).toBe(false);
        expect(g.state().stale).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        fail = false;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(g.state().stale).toBe(false);
        g.stop();
    });

    it('boot error fails open; later success applies', async () => {
        let fail = true;
        const g = mk(async () => {
            if (fail) throw new Error('down');
            return 'green';
        });
        await g.start();
        expect(g.isActive()).toBe(true);
        fail = false;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(g.isActive()).toBe(false);
        g.stop();
    });

    it('boot read that hangs times out and starts active', async () => {
        const g = mk(() => new Promise<string>(() => {}), { bootTimeoutMs: 1_000 });
        const started = g.start();
        await vi.advanceTimersByTimeAsync(1_000);
        await started;
        expect(g.isActive()).toBe(true);
        g.stop();
    });

    it('deleting the param reverts to active', async () => {
        let v: string | undefined = 'green';
        const g = mk(async () => {
            if (v === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
            return v;
        });
        await g.start();
        expect(g.isActive()).toBe(false);
        v = undefined;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(g.isActive()).toBe(true);
        g.stop();
    });

    it('jitter stays within bounds and stop() halts polling', async () => {
        const get = vi.fn(async () => 'blue');
        const g = mk(get, { random: () => 0, jitter: 0.2 }); // delay = 8000ms
        await g.start();
        expect(get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2);
        expect(get).toHaveBeenCalledTimes(2);
        g.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(get).toHaveBeenCalledTimes(2);
    });

    it('a throwing listener does not break others', async () => {
        const g = mk(async () => 'green');
        const ok = vi.fn();
        g.on('change', () => {
            throw new Error('x');
        });
        g.on('change', ok);
        await g.start();
        expect(ok).toHaveBeenCalledWith(false, 'green');
        g.stop();
    });

    it('unsubscribe works', async () => {
        const g = mk(async () => 'green');
        const l = vi.fn();
        g.on('change', l)();
        await g.start();
        expect(l).not.toHaveBeenCalled();
        g.stop();
    });
});
