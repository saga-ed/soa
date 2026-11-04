<script lang="ts">
 import type { MeshSnapshot } from '$lib/graph/types';
 import type { DatadogSnapshot, SignalView } from '$lib/graph/datadog';
 import type { DemoSignal } from '$lib/fixtures/signals';
 import { investigationRows, investigationView, filterInvestigation, sortInvestigation, defaultInvestigationSort, type InvestigationState, type SortColumn } from '$lib/graph/investigation';
 let { state = $bindable(), snapshot, data, signalView, now, failed = false, demoSignals = {}, onselect, oninspect, onview }: {
  state: InvestigationState; snapshot: MeshSnapshot; data: DatadogSnapshot | null; signalView: SignalView;
  now: number; failed?: boolean; demoSignals?: Record<string, DemoSignal>;
  onselect: (id: string | null) => void; oninspect: (id: string | null) => void; onview: (view: SignalView) => void;
 } = $props();
 let view = $derived(investigationView(signalView));
 let evidence = $derived(investigationRows(snapshot, data, view, now, failed, demoSignals));
 let filtered = $derived(filterInvestigation(evidence.rows, state, snapshot));
 let sort = $derived(state.sortView === view && state.sort ? state.sort : defaultInvestigationSort(view, filtered));
 let descending = $derived(state.sortView === view && state.sort ? state.descending : true);
 let rows = $derived(sortInvestigation(filtered, sort, descending));
 let selectedRow = $derived(rows.find(row => row.key === state.row));
 let path = $derived(snapshot.relationships.find(r => r.id === state.path));
 const label = (id: string) => snapshot.systems.find(s => s.id === id)?.label ?? id;
 let systems = $derived([...new Set([...snapshot.systems.map(s => s.id), ...evidence.rows.flatMap(r => [r.source, r.target])])].sort((a,b) => label(a).localeCompare(label(b))));
 let columns: { key: SortColumn; label: string }[] = $derived(view === 'fanout' ? [
  { key: 'source', label: 'Caller' }, { key: 'target', label: 'Callee' }, { key: 'parentResource', label: 'Parent endpoint' }, { key: 'resource', label: 'Child endpoint' },
  { key: 'meanCalls', label: 'Mean calls / parent' }, { key: 'maxCalls', label: 'Max calls / parent' }, { key: 'parents', label: 'Sampled parents' }, { key: 'calls', label: 'Sampled calls' },
 ] : [
  { key: 'source', label: 'Caller' }, { key: 'target', label: 'Callee' }, { key: 'resource', label: 'Endpoint' },
  { key: 'rate', label: 'Requests/sec' }, { key: 'count', label: 'HTTP attempts' }, { key: 'p95', label: 'Sample p95 (ms)' }, { key: 'retained', label: 'Retained calls' }, { key: 'errorPercent', label: 'Error %' },
 ]);
 const value = (v: string | number | null) => v == null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v;
 const windowLabel = (window: {from: number; to: number} | undefined) => window && Number.isFinite(window.from) && Number.isFinite(window.to)
  ? `${new Date(window.from).toISOString().replace('T',' ').replace('.000Z',' UTC')} – ${new Date(window.to).toISOString().replace('T',' ').replace('.000Z',' UTC')}` : 'Unavailable';
 function changeSort(column: SortColumn) {
  state = { ...state, sort: column, sortView: view, descending: sort === column ? !descending : true };
 }
</script>

<section class="investigation" aria-label="Call offenders">
 <div class="investigation-title"><h2>Call offenders</h2><button aria-expanded={state.expanded} onclick={() => state = { ...state, expanded: !state.expanded }}>{state.expanded ? 'Collapse table' : 'Expand table'}</button></div>
 <div class="investigation-filters">
  <label>Investigate<select aria-label="Investigate" value={view} onchange={event => onview(event.currentTarget.value as SignalView)}><option value="hot">Hot calls</option><option value="slow">Slow calls</option><option value="fanout">High fan-out</option></select></label>
  <label>Filter by system<select aria-label="Filter by system" value={state.system} onchange={event => onselect(event.currentTarget.value || null)}><option value="">All systems</option>{#each systems as id}<option value={id}>{label(id)}</option>{/each}</select></label>
  <label>Call direction<select aria-label="Call direction" value={state.direction} disabled={!state.system} onchange={event => state = { ...state, direction: event.currentTarget.value as InvestigationState['direction'], row: null }}><option value="both">Both directions</option><option value="from">Calls from system</option><option value="to">Calls to system</option></select></label>
  <button onclick={() => onselect(null)}>Clear filter</button>
 </div>
 {#if state.path}<p class="investigation-path">Path filter: {path ? `${label(path.source)} → ${label(path.target)}` : 'Selected connection no longer available'}{#if path && !['http','dependency'].includes(path.kind)} · HTTP call evidence is unavailable for this connection type.{/if}</p>{/if}
 <p class="investigation-count" role="status">{rows.length} of {evidence.rows.length} {Object.keys(demoSignals).length ? 'simulated paths' : view === 'fanout' ? 'parent/child endpoint pairs' : 'measured endpoints'} · sorted by {columns.find(c => c.key === sort)?.label} {descending ? '(highest first)' : '(lowest first)'}.</p>
 {#if view === 'hot' && sort === 'retained'}<p>Request rates unavailable for these rows. Ranking retained calls, not total traffic or requests/sec.</p>{/if}
 {#each evidence.notes as note}<p class="investigation-note">{note}</p>{/each}
 <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the wide table.) -->
 <div class="investigation-scroll" tabindex="0" role="region" aria-label="Scrollable call offenders table">
  <table class="investigation-table">
   <caption class="sr-only">{view === 'hot' ? 'Hot' : view === 'slow' ? 'Slow' : 'Fan-out'} call offenders. Select an endpoint for evidence; sort with column headers. Unknown measurements are last.</caption>
   <thead><tr>{#each columns as column}<th scope="col" aria-sort={sort === column.key ? descending ? 'descending' : 'ascending' : 'none'}><button onclick={() => changeSort(column.key)}>{column.label}{sort === column.key ? descending ? ' ↓' : ' ↑' : ''}</button></th>{/each}</tr></thead>
   <tbody>{#each rows as row (row.key)}<tr class:investigation-selected={state.row === row.key} data-call-key={row.key}>
    {#each columns as column}<td class:metric-cell={typeof row[column.key] === 'number'}>
     {#if column.key === 'resource'}<button class="endpoint-link" aria-pressed={state.row === row.key} aria-label={`Inspect call ${row.source} → ${row.target}: ${row.resource}${row.parentResource ? ` from ${row.parentResource}` : ''}`} onclick={() => { state = { ...state, row: row.key }; oninspect(row.relationship ?? row.source); }}>{row.resource}</button>
     {:else if column.key === 'source' || column.key === 'target'}{label(row[column.key])}
     {:else}{value(row[column.key])}{/if}
    </td>{/each}
   </tr>{:else}<tr><td colspan={columns.length}>No current calls match this filter. Clear the filter or select another system or signal view.</td></tr>{/each}</tbody>
  </table>
 </div>
 <p class="investigation-note">— means unavailable. A measured zero remains 0. Select an endpoint to highlight its mesh path and inspect evidence below.</p>
 {#if selectedRow}
  <section class="investigation-evidence" aria-label="Selected call evidence">
   <div class="investigation-title"><h3>Selected call evidence</h3><button onclick={() => { state = { ...state, row: null }; oninspect(state.path ?? (state.system || null)); }}>Close call evidence</button></div>
   <strong>{selectedRow.resource}</strong><p>{label(selectedRow.source)} → {label(selectedRow.target)}</p>
   {#if selectedRow.parentResource}<p>Parent: {selectedRow.parentResource}</p>{/if}
   {#if selectedRow.simulated}<p><strong>SIMULATED</strong> · {selectedRow.note}</p>{/if}
   <dl>{#each columns.filter(c => !['source','target','resource','parentResource'].includes(c.key)) as column}<div><dt>{column.label}</dt><dd>{value(selectedRow[column.key])}</dd></div>{/each}</dl>
   {#if !selectedRow.simulated}<p>Trace observation window: {windowLabel(data?.window)}</p>{#if view !== 'fanout'}<p>Counter window: {windowLabel(data?.pathRateWindow)}</p>{/if}{/if}
   {#if !selectedRow.relationship}<p>No matching HTTP connection is present in the current mesh. The caller is highlighted.</p>{/if}
  </section>
 {:else if state.row}<p role="status">The selected measurement is no longer in the current results. Filter and sort are preserved.</p>{/if}
</section>
