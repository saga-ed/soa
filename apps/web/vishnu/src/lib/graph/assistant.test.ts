import { describe, expect, it } from 'vitest';
import { applyView, initialView, resourceRows, type ResourceSnapshot } from './assistant';
import { createFixture } from '../fixtures/mesh';
describe('shared assistant and manual navigation', () => {
  const mesh = createFixture('overview');
  it('sets filters atomically and restores a deep independent copy of the prior view', () => {
    const previous = initialView();
    const system = mesh.systems[0].id;
    const next = applyView(
      previous,
      { type: 'show_calls', view: 'slow', system, direction: 'to' },
      mesh
    );
    expect(next).toMatchObject({
      selected: system,
      signalView: 'slow',
      showInspector: true,
      investigation: { mode: 'table', system, direction: 'to', sort: 'p95' },
    });
    const restored = applyView(next, { type: 'restore_view' }, mesh, previous);
    expect(restored).toEqual(previous);
    expect(restored).not.toBe(previous);
    expect(applyView(next, { type: 'reset_view' }, mesh)).toEqual(initialView());
  });
  it('rejects invented or stale model IDs', () => {
    expect(() =>
      applyView(initialView(), { type: 'show_resources', system: 'invented', sort: 'cpu' }, mesh)
    ).toThrow();
    expect(() =>
      applyView(
        initialView(),
        { type: 'show_calls', view: 'hot', system: '', direction: 'both', path: 'old-path' },
        mesh
      )
    ).toThrow();
  });
  it('does not rank missing or stale resources as healthy', () => {
    const data: ResourceSnapshot = {
      status: 'ready',
      source: 'datadog',
      scope: { environment: 'dev', deployment: 'all' },
      observedAt: new Date(0).toISOString(),
      window: { from: 0, to: 1 },
      instances: [],
      message: '',
    };
    expect(resourceRows(data, '', 'cpu')).toEqual([]);
  });
});
