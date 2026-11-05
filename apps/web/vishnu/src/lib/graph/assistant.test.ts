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

describe('historical chart navigation', () => {
  it('adds and edits charts atomically, bounds the set, and restores the prior mesh', () => {
    const mesh = createFixture('overview');
    const chart = { id: '00000000-0000-4000-8000-000000000001', title: 'CPU', system: mesh.systems[0].id,
      kind: 'line' as const, metric: 'cpu' as const, statistics: ['avg' as const], time: {mode:'rolling' as const, minutes:30}, group:'service' as const, population:'observations' as const };
    const before = initialView();
    const after = applyView(before, {type:'show_chart',chart}, mesh);
    expect(after.meshCollapsed).toBe(true); expect(after.charts).toHaveLength(1);
    const edited = applyView(after, {type:'show_chart',chart:{...chart,title:'Renamed'}}, mesh);
    expect(edited.charts).toHaveLength(1); expect(edited.charts?.[0].title).toBe('Renamed');
    expect(applyView(edited,{type:'restore_view'},mesh,before)).toEqual(before);
    expect(()=>applyView({...after,charts:Array.from({length:8},(_,i)=>({...chart,id:String(i)}))},{type:'show_chart',chart},mesh)).toThrow('Chart limit');
  });
});
