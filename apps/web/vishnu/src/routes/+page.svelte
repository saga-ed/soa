<script lang="ts">
 import { nodeObservation } from '$lib/graph/node-observation';
 import { serviceSignal } from '$lib/graph/datadog';
 import FanoutIcon from '$lib/components/FanoutIcon.svelte';
 import { matchesMesh, type DatadogSnapshot, type SignalView } from '$lib/graph/datadog';
 import { createSignalDemo, demoSignals } from '$lib/fixtures/signals';
 import { onMount, tick } from 'svelte';
 import { createFixture } from '$lib/fixtures/mesh';
 import { createLayoutWorker } from '$lib/graph/worker-layout';
 import type { MeshLayout, MeshSnapshot } from '$lib/graph/types';
 import MeshGraph from '$lib/components/MeshGraph.svelte';
 import MqStats from '$lib/components/MqStats.svelte';
 import { hostedMqLabel, hostedMqScope, scopedStats, serviceStats, type HostedMqScope, type StatsSnapshot, type MqViews } from '$lib/graph/event-stats';
 import SideInspector from '$lib/components/SideInspector.svelte';
 import { initialInvestigation, selectInvestigation } from '$lib/graph/investigation';
 let investigation = $state(initialInvestigation());
 import DisplaySettings from '$lib/components/DisplaySettings.svelte';
 import AssistantPanel from '$lib/components/AssistantPanel.svelte';
 import ResourcesPanel from '$lib/components/ResourcesPanel.svelte';
 import { applyView, viewKey, resourceRows, resourcePressure, type ViewState, type ViewAction, type ResourceSnapshot, type ResourceSort } from '$lib/graph/assistant';
 let showAssistant = $state(false), showResources = $state(false);
 let resources = $state<ResourceSnapshot | null>(null);
 let resourceSystem = $state(''), resourceSort = $state<ResourceSort>('cpu');
 let previousViews = $state<ViewState[]>([]);
 let acceptedContext = '', appliedKey = '';
 const copyView = () => JSON.parse(viewKey(currentView)) as ViewState;
 function displayView(view: ViewState) {
  selected = view.selected; signalView = view.signalView; investigation = view.investigation;
  showInspector = view.showInspector; showResources = view.showResources;
  resourceSystem = view.resourceSystem; resourceSort = view.resourceSort; hover = null;
  fitRequest++;
 }
 function restoreView() {
  const previous = previousViews.at(-1);
  if (previous) { previousViews = previousViews.slice(0,-1); displayView(previous); }
  acceptedContext = ''; appliedKey = '';
 }
 function navigate(action: ViewAction, context = viewKey(currentView)): boolean {
  if (!snapshot) return false;
  const key = viewKey(currentView);
  if (context !== key && !(acceptedContext === context && appliedKey === key)) return false;
  if (action.type === 'restore_view') { restoreView(); return true; }
  try {
   const next = applyView(copyView(), action, snapshot);
   if (acceptedContext !== context) previousViews = [...previousViews.slice(-9), copyView()];
   acceptedContext = context;
   if (action.type === 'reset_view') void resetView(); else displayView(next);
   appliedKey = viewKey(next);
   return true;
  } catch { return false; }
 }
 let resourceNow = $derived.by(() => { clock; return Date.now(); });
 let resourceHighlights = $derived(showResources ? Object.fromEntries(resourceRows(resources, resourceSystem, resourceSort, resourceNow).filter(r => resourcePressure(r) >= 80).map(r => [r.system, true])) : {});

 let topN = $state(5);
 let datadog = $state<DatadogSnapshot | null>(null);
 let datadogError = $state(false);
 let focusSignals = $state(true);
 let signalView = $state<SignalView>('overview');
 let datadogLoadedAt = $state(0);
 let stats = $state<StatsSnapshot | null>(null);
 let statsError = $state('');
 let mqEnabled = $state(true);
 let hostedMq = $state<HostedMqScope | null>(null);
 let statsLoadedAt = $state(0);
 let clock = $state(0);
 let hover = $state<{id: string; x: number; y: number} | null>(null);
 let hoverTimer: ReturnType<typeof setTimeout>;
 const dismissHover = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => hover = null, 180); };
 const preview = (id: string | null, rect?: DOMRect) => {
  if (!id || !rect) { dismissHover(); return; }
  clearTimeout(hoverTimer);
  hover = {id, x: Math.max(12, Math.min(rect.left, window.innerWidth - 352)), y: rect.bottom + 428 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - 428)};
 };
 let demo = $state(false);
 let scenario = $state<'overview' | 'incident' | 'missing'>('incident');
 let liveSnapshot = $state<MeshSnapshot | null>(null);
 let mode = $state<'loading' | 'fixture' | 'live'>('loading');
 let disconnected = $state('');
 let snapshot = $derived(mode === 'fixture' ? (demo ? createSignalDemo() : createFixture(scenario)) : liveSnapshot);
 let datadogNow = $derived(datadog ? datadog.serverNow + Math.max(0, clock - datadogLoadedAt) : 0);
 let scopedDatadog = $derived(matchesMesh(datadog, snapshot) ? datadog : null);
 let sourceLabel = $derived(mode === 'fixture' ? (demo ? 'SIMULATED SIGNALS' : 'Fixture preview') : mode === 'loading' ? 'Connecting…' : `${snapshot?.environment ?? 'Synthetic dev'}${snapshot?.slot != null ? ` · slot ${snapshot.slot}` : ''}`);
 let mqViews: MqViews = $derived.by(() => {
  const scoped = scopedStats(stats, snapshot, hostedMq);
  return Object.fromEntries((snapshot?.systems ?? []).map(s => [s.id, serviceStats(scoped, s.id, Math.max(0,clock-statsLoadedAt), !!statsError)]));
 });
 let layout = $state<MeshLayout | null>(null);
 // Resize/reset wraps bands to the canvas shape; inspector toggles preserve the camera.
 let canvasWidth = $state(0);
 let canvasHeight = $state(0);
 let layoutAspect = 16 / 9;
 let layoutSeq = 0;
 let fitRequest = $state(0);
 let resetRequest = $state(0);
 let scheduleRelayout: (() => void) | undefined;
 const canvasAspect = () => canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : window.innerWidth / window.innerHeight;

 let failure = $state('');
 let selected = $state<string | null>(null);
 function selectItem(id: string | null) {
  selected = id; hover = null;
  investigation = selectInvestigation(investigation, snapshot, id);
  if (id) showInspector = true;
 }
 let search = $state('');
 let focused = $state(false);
 let showInspector = $state(false);
 let currentView = $derived<ViewState>({ selected, signalView, investigation, showInspector, showResources, resourceSystem, resourceSort });

 let tableWasExpanded = false;
 $effect(() => {
  const expanded = showInspector && investigation.mode === 'table' && investigation.expanded;
  if (expanded !== tableWasExpanded) { tableWasExpanded = expanded; void tick().then(() => fitRequest++); }
 });
 $effect(() => { if (selected) showInspector = true; });
 let showList = $state(false);
 async function resetView() {
  selected = null; search = ''; hover = null; showInspector = false; showList = false;
  signalView = 'overview'; focusSignals = true; focused = false; investigation = initialInvestigation();
  showResources = false; resourceSystem = ''; resourceSort = 'cpu';
  clearTimeout(hoverTimer); resetRequest++;
  await tick(); scheduleRelayout?.();
 }
 async function toggleFocus() { focused = !focused; await tick(); fitRequest++; }

 let selectedLabel = $derived(snapshot?.systems.find(s => s.id === selected)?.label ?? snapshot?.relationships.find(r => r.id === selected)?.label ?? 'None');
 let matches = $derived(snapshot?.systems.filter(s => s.label.toLowerCase().includes(search.toLowerCase())) ?? []);
 onMount(() => {
  const worker = createLayoutWorker();
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const requests = new Set<AbortController>();
  let statsTimer: ReturnType<typeof setTimeout>;
  let datadogTimer: ReturnType<typeof setTimeout>;
  let resourceTimer: ReturnType<typeof setTimeout>;
  const pollResources = async () => { try { resources = await fetchJson('/api/resources'); } catch { resources = null; } finally { if (active) resourceTimer = setTimeout(pollResources, 60000); } };
  const clockTimer = setInterval(() => clock = performance.now(), 1000);
  let apiUrl = '/api/mesh';
  let pollMs = 15000;
  let relayoutTimer: ReturnType<typeof setTimeout>;
  const layoutFor = (next: MeshSnapshot) => { layoutAspect = canvasAspect(); layoutSeq++; return worker.layout(next, layoutAspect); };
  scheduleRelayout = () => {
   clearTimeout(relayoutTimer);
   relayoutTimer = setTimeout(async () => {
    if (!snapshot) return;
    const next = layoutFor($state.snapshot(snapshot) as MeshSnapshot), seq = layoutSeq;
    try { const result = await next; if (active && seq === layoutSeq) { layout = result; fitRequest++; } } catch { /* Keep the current layout. */ }
   }, 250);
  };
  const fetchJson = async (url: string) => {
   const request = new AbortController();
   requests.add(request);
   const timeout = setTimeout(() => request.abort(), 10000);
   try {
    const response = await fetch(url, { cache: 'no-store', signal: request.signal });
    if (response.status === 401) { location.assign('/auth/login'); throw new Error('Staff sign-in required'); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
   } finally { clearTimeout(timeout); requests.delete(request); }
  };
  const pollDatadog = async () => {
   try {
    const next: DatadogSnapshot = await fetchJson('/api/datadog');
    if (next.version !== 1 || !next.scope || !Array.isArray(next.services) || !Array.isArray(next.dependencies) || !Number.isFinite(Date.parse(next.observedAt)) || !Number.isFinite(next.serverNow)) throw new Error('Invalid Datadog response');
    if (!active) return;
    datadog = next; datadogError = false; datadogLoadedAt = performance.now();
   } catch { if (active) datadogError = true; }
   finally { if (active) datadogTimer = setTimeout(pollDatadog, 60000); }
  };
  const pollStats = async () => {
   try {
    const next: StatsSnapshot = await fetchJson('/api/event-stats');
    if (next.version !== 1 || !next.scope || !next.receiver || !Array.isArray(next.sources) || !Number.isFinite(Date.parse(next.observedAt)) || !(next.staleAfterMs > 0) || !next.sources.every(s => s.report?.identity && Array.isArray(s.report.streams) && Array.isArray(s.report.capabilities) && Number.isFinite(Date.parse(s.receivedAt)))) throw new Error('Invalid statistics response');
    if (!active) return;
    stats = next; statsLoadedAt = performance.now(); clock = statsLoadedAt; statsError = '';
   } catch {
    if (active) statsError = 'MQ statistics unavailable; retrying';
   } finally { if (active) statsTimer = setTimeout(pollStats, 5000); }
  };
  const poll = async () => {
   try {
    const next: MeshSnapshot = await fetchJson(apiUrl);
    if (next.mode !== 'live' || !Array.isArray(next.systems) || !Array.isArray(next.relationships) || !next.topologyVersion || !Number.isFinite(Date.parse(next.observedAt))) throw new Error('Invalid live mesh response');
    const nextLayout = !layout || next.topologyVersion !== liveSnapshot?.topologyVersion ? await layoutFor(next) : layout;
    if (!active) return;
    layout = nextLayout;
    liveSnapshot = next;
    disconnected = '';
    failure = '';
    if (selected && !next.systems.some(s => s.id === selected) && !next.relationships.some(r => r.id === selected)) selected = null;
   } catch (error) {
    if (!active) return;
    disconnected = `Live collector unavailable: ${error instanceof Error ? error.message : String(error)}`;
    if (liveSnapshot) liveSnapshot = { ...liveSnapshot, systems: liveSnapshot.systems.map(s => ({ ...s, freshness: 'stale' })), relationships: liveSnapshot.relationships.map(r => ({ ...r, freshness: 'stale' })) };
   } finally { if (active) timer = setTimeout(poll, pollMs); }
  };
  const start = async () => {
   const requested = new URLSearchParams(location.search).get('mode');
   demo = requested === 'demo';
   let config: { mode?: string; apiUrl?: string; pollIntervalMs?: number; mqEnabled?: boolean; environment?: string; mqDeployment?: string | null; mqPreviewTag?: string } = {};
   if (requested !== 'fixture' && !demo) {
    try { config = await fetchJson('/config.json'); } catch { /* Static fixture builds have no runtime config. */ }
   }
   if (!active) return;
   mode = requested === 'fixture' || demo ? 'fixture' : requested === 'live' || config.mode === 'live' || import.meta.env.VITE_VISHNU_MODE === 'live' ? 'live' : 'fixture';
   if (mode === 'live') {
    apiUrl = config.apiUrl || '/api/mesh';
    pollMs = Math.max(3000, Number(config.pollIntervalMs) || 15000);
    mqEnabled = config.mqEnabled !== false;
    hostedMq = hostedMqScope(config);
    if (mqEnabled) void pollStats();
    void pollDatadog();
    await poll();
   } else {
    try { await tick(); const result = await layoutFor(demo ? createSignalDemo() : createFixture('overview')); if (active) layout = result; }
    catch (error) { if (active) failure = String(error); }
   }
  };
  void start();
  void pollResources();
  return () => { active = false; clearTimeout(timer); clearTimeout(statsTimer); clearTimeout(datadogTimer); clearTimeout(resourceTimer); clearTimeout(hoverTimer); clearTimeout(relayoutTimer); clearInterval(clockTimer); for (const request of requests) request.abort(); worker.terminate(); };
 });
</script>
<svelte:head><title>Vishnu · Saga mesh</title><meta name="description" content="Saga mesh topology, system health, and evidence." /></svelte:head>
<svelte:window onresize={() => scheduleRelayout?.()} onkeydown={(event) => { if (event.key === 'Escape') { clearTimeout(hoverTimer); if (hover) hover = null; else { selectItem(null); search = ''; } } }} />
<div class="app-shell" class:focused>
 <nav class="app-nav" aria-label="Main"><div class="nav-context"><a class="vishnu-brand" href="/" aria-label="Vishnu home"><img src="/vishnu-logo-on-dark.png" alt="Vishnu — Saga Mesh Observability" width="2172" height="724" /></a></div><a class="active-nav" aria-current="page" href="/">◈ &nbsp; Mesh overview</a><div class="nav-bottom">{sourceLabel}<br/><small>{mode === 'fixture' ? 'Design & interaction study' : snapshot?.scope ? 'Cloud mesh observations' : 'Local stack health probes'}</small></div></nav>
 <div class="app-main"><header class="topbar"><a href="/" class="compact-brand" aria-label="Vishnu home"><img src="/vishnu-logo-on-light.png" alt="Vishnu — Saga Mesh Observability" width="2172" height="724" /></a><span class="preview-badge">{sourceLabel}</span><DisplaySettings bind:topN /></header>
 <main id="mesh-main">
 {#if mode === 'live'}<p class="live-status" role="status">{#if disconnected}{disconnected}. {snapshot ? 'Showing the last observation, marked stale.' : 'Waiting for mesh observations.'} Retrying automatically.{:else}{snapshot?.scope ? 'Source-declared topology · Datadog observations' : 'Local health probes · declared product topology'} · MQ telemetry{#if hostedMq} ({hostedMqLabel(hostedMq)}){/if} {!mqEnabled ? 'not enabled' : statsError ? 'unavailable' : stats?.receiver.connected ? 'connected' : 'connecting'}{/if} <a href="?mode=fixture">Open fixture preview</a></p>{/if}
 {#if snapshot}
 {#if mode === 'live'}<p class="datadog-status" role="status">Datadog: {datadogError ? 'unavailable; retrying' : datadog?.status ?? 'connecting'}{#if datadog} · {datadog.scope.environment} / {datadog.scope.deployment}{#if datadog.scope.machine} / {datadog.scope.machine}{/if}{#if !scopedDatadog} · separate scope; graph overlay disabled{/if}{/if}. Select a service or connection for endpoint and caller → callee measurements.</p>{/if}
 {#if demo}<div class="demo-banner"><strong>SIMULATED SIGNALS · stand-up demo</strong><span>Invented measurements and call chains. No live APIs or Datadog queries.</span><a href="/">Return to live view ↗</a></div>{:else}<span class="demo-entry"><a href="?mode=demo">Demo ↗</a></span>{/if}
 <div class="toolbar">{#if mode === 'live' || demo}<label>Signal view <select bind:value={signalView}><option value="overview">All paths · early warnings</option><option value="hot">Hot paths</option><option value="slow">Slow paths</option><option value="error">Errors</option><option value="attention">Warnings & alerts</option><option value="fanout">Fan-out</option></select></label><label class="focus-layout-toggle"><input type="checkbox" bind:checked={focusSignals} /> Reflow signal focus</label>{/if}{#if mode === 'fixture' && !demo}<label>Fixture scenario <select bind:value={scenario}><option value="overview">Healthy overview</option><option value="incident">Consumer incident</option><option value="missing">Missing telemetry</option></select></label>{/if}<div class="search"><label for="system-search">Find a system</label><input id="system-search" type="search" placeholder="Search systems…" bind:value={search} />{#if search}<div class="search-results">{#each matches as s}<button onclick={() => { selectItem(s.id); search = ''; }}>{s.label}</button>{:else}<p>No matching systems</p>{/each}</div>{/if}</div><div class="view-actions"><button aria-expanded={showAssistant} onclick={() => showAssistant = !showAssistant}>Ask Vishnu</button><button aria-pressed={showResources} onclick={() => { if (showResources) showResources = false; else navigate({ type: 'show_resources', system: snapshot?.systems.some(s => s.id === selected) ? selected! : '', sort: resourceSort }); }}>Resources</button><button onclick={resetView}>Reset view</button><button aria-pressed={focused} onclick={toggleFocus}>{focused ? 'Exit focus' : 'Focus canvas'}</button><button aria-expanded={showInspector} aria-controls="selection-inspector" onclick={() => showInspector = !showInspector}>{showInspector ? 'Hide inspector' : 'Show inspector'}</button><button aria-expanded={showList} aria-controls="mesh-list" onclick={() => showList = !showList}>{showList ? 'Hide list' : 'Browse as list'}</button></div><span class="summary-count">{snapshot.systems.length} systems · {snapshot.relationships.length} paths</span></div>
 {#if demo}<div class="signal-legend" aria-label="Signal legend"><span style="--signal-color:var(--color-attention-strong)">↗ Hot traffic</span><span style="--signal-color:var(--color-primary)">◷ Slow paths</span><span style="--signal-color:var(--chart-2)"><FanoutIcon /> Fan-out</span><span style="--signal-color:var(--color-signal-error)">! Errors / breached threshold</span><small>Intensity = budget used · 35–100% opacity · ▲ early warning from 70% · full connectivity stays visible</small></div>{/if}
 <p class="sr-only" role="status" aria-live="polite">Selected: {selectedLabel}. {showInspector ? 'Details are in the selection inspector.' : 'Use Show inspector for details.'}</p>
 {#if showList}<section class="mesh-list" id="mesh-list" aria-label="Mesh systems and relationships"><div><h3>Systems</h3><ul>{#each snapshot.systems as system}<li><button aria-pressed={selected === system.id} onclick={() => selectItem(system.id)}>{system.label}<small>{system.kind} · {nodeObservation(system, serviceSignal(scopedDatadog, system.id, datadogNow, datadogError), mqViews[system.id], mode === 'live').label}</small></button></li>{/each}</ul></div><div><h3>Relationships</h3><ul>{#each snapshot.relationships as relationship}<li><button aria-pressed={selected === relationship.id} onclick={() => selectItem(relationship.id)}>{relationship.label}<small>{snapshot?.systems.find(s => s.id === relationship.source)?.label} → {snapshot?.systems.find(s => s.id === relationship.target)?.label}<br/>{relationship.kind} · {relationship.health} · {relationship.freshness}</small></button></li>{/each}</ul></div></section>{/if}
 <div class="assisted-workspace" class:with-assistant={showAssistant}>
 {#if showAssistant}<aside class="assistant-rail"><AssistantPanel contextKey={viewKey(currentView)} onaction={navigate} onrestore={restoreView} canRestore={previousViews.length > 0}/></aside>{/if}
 <div class="investigation-surface">
 {#if showResources}<ResourcesPanel data={resources} mesh={snapshot} bind:system={resourceSystem} bind:sort={resourceSort} onselect={id => { selected = id; }} now={resourceNow}/>{/if}
 <div class="workspace" class:inspector-hidden={!showInspector} class:inspector-expanded={showInspector && investigation.mode === 'table' && investigation.expanded}><section class="graph-panel" aria-label="Interactive service mesh"><div class="band-labels"><span>DATA SYSTEMS</span><span>MESH SERVICES</span><span>APPLICATIONS</span></div><div class="graph-canvas" bind:clientWidth={canvasWidth} bind:clientHeight={canvasHeight}>{#if layout}<MeshGraph {resourceHighlights} {resetRequest} {focusSignals} demoSignals={demo ? demoSignals : {}} datadog={scopedDatadog} {datadogError} now={datadogNow} {signalView} {snapshot} {layout} {selected} {mqViews} {fitRequest} onpreview={preview} onselect={selectItem}/>{:else if failure}<p role="alert">Could not lay out mesh: {failure}</p>{:else}<p role="status">Laying out the mesh…</p>{/if}</div><div class="graph-footer">Drag to pan · Scroll to zoom · Tab then Enter to select<span>Hover path markers for details · signal views reflow with context</span></div></section>{#if showInspector}<SideInspector bind:investigation oninspect={id => selected = id} onview={view => signalView = view} {signalView} {topN} demoSignals={demo ? demoSignals : {}} datadog={scopedDatadog} {datadogError} now={datadogNow} {snapshot} {selected} {mqViews} onselect={selectItem}/>{/if}</div>
 </div></div>
 {:else}<p role="status">{disconnected || 'Connecting to the mesh…'}</p>{/if}
 </main></div>
</div>

{#if hover}
 <div class="mq-preview nodrag nopan" role="dialog" aria-label="MQ statistics preview" tabindex="-1" style:left={`${hover.x}px`} style:top={`${hover.y}px`} onmouseenter={() => clearTimeout(hoverTimer)} onmouseleave={dismissHover} onfocusin={() => clearTimeout(hoverTimer)} onfocusout={dismissHover}>
  <header><strong>{snapshot?.systems.find(s => s.id === hover?.id)?.label}</strong><button aria-label="Close MQ preview" onclick={() => hover = null}>×</button></header>
  <MqStats view={mqViews[hover.id]} compact />
  <button class="details-button" onclick={() => { selectItem(hover!.id); showInspector = true; }}>Open inspector</button>
 </div>
{/if}

<style>
 .assisted-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: .75rem; flex: 1; min-height: 360px; }
 .assisted-workspace.with-assistant { grid-template-columns: clamp(420px, 32vw, 600px) minmax(0, 1fr); }
 .assistant-rail, .investigation-surface { min-width: 0; }
 .investigation-surface { display: flex; flex-direction: column; min-height: 0; }
 .assistant-rail { max-height: calc(100vh - 190px); overflow: auto; }
 @media (max-width: 1200px) {
  .assisted-workspace.with-assistant { grid-template-columns: minmax(0, 1fr); }
  .assisted-workspace.with-assistant { grid-template-rows: auto minmax(440px, 1fr); }
  .assistant-rail { max-height: none; }
 }
</style>
