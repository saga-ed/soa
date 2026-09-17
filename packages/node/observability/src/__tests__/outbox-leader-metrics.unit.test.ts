import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createObservability } from '../metrics.js';

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

// addOutbox only needs `pool` for the lag gauge's collect() callback, which
// these tests never trigger (no registry.metrics() scrape) — a minimal stub
// satisfies the Pool type at the call site without a real connection.
function makePool(): Pool {
    return { query: vi.fn() } as unknown as Pool;
}

async function seriesFor(
    registry: ReturnType<typeof createObservability>['registry'],
    name: string,
) {
    const metric = await registry.getSingleMetric(name)?.get();
    return metric?.values ?? [];
}

describe('createOutboxMetrics leader hooks', () => {
    it('labels onLeaderAcquired/onLeaderLost/onLeaderWaiting with the instance, defaulting to empty string', async () => {
        const { registry, addOutbox } = createObservability('test-svc', makeLogger() as never);
        const metrics = addOutbox(makePool());

        metrics.onLeaderAcquired?.('blue');
        metrics.onLeaderLost?.('blue');
        metrics.onLeaderWaiting?.(); // no instance passed

        const acquired = await seriesFor(registry, 'outbox_leader_acquired_total');
        expect(acquired).toContainEqual(
            expect.objectContaining({ labels: { instance: 'blue' }, value: 1 }),
        );

        const lost = await seriesFor(registry, 'outbox_leader_lost_total');
        expect(lost).toContainEqual(
            expect.objectContaining({ labels: { instance: 'blue' }, value: 1 }),
        );

        const waiting = await seriesFor(registry, 'outbox_leader_waiting_total');
        expect(waiting).toContainEqual(
            expect.objectContaining({ labels: { instance: '' }, value: 1 }),
        );
    });

    it('labels onLeaderYielded with both reason and instance', async () => {
        const { registry, addOutbox } = createObservability('test-svc', makeLogger() as never);
        const metrics = addOutbox(makePool());

        metrics.onLeaderYielded?.('failures', 'green');
        metrics.onLeaderYielded?.('tick-timeout', 'green');
        metrics.onLeaderYielded?.('failures'); // no instance passed

        const yielded = await seriesFor(registry, 'outbox_leader_yielded_total');
        expect(yielded).toContainEqual(
            expect.objectContaining({
                labels: { reason: 'failures', instance: 'green' },
                value: 1,
            }),
        );
        expect(yielded).toContainEqual(
            expect.objectContaining({
                labels: { reason: 'tick-timeout', instance: 'green' },
                value: 1,
            }),
        );
        expect(yielded).toContainEqual(
            expect.objectContaining({
                labels: { reason: 'failures', instance: '' },
                value: 1,
            }),
        );
    });
});
