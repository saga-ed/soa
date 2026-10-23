<script lang="ts">
 import FanoutIcon from '$lib/components/FanoutIcon.svelte';
 import { matchesMesh, type DatadogSnapshot, type SignalView } from '$lib/graph/datadog';
 import { createSignalDemo, demoSignals } from '$lib/fixtures/signals';
 import { onMount } from 'svelte';
 import { createFixture } from '$lib/fixtures/mesh';
 import { createLayoutWorker } from '$lib/graph/worker-layout';
 import type { MeshLayout, MeshSnapshot } from '$lib/graph/types';
 import MeshGraph from '$lib/components/MeshGraph.svelte';
 import MqStats from '$lib/components/MqStats.svelte';
 import { serviceStats, type StatsSnapshot, type MqViews } from '$lib/graph/event-stats';
 import SideInspector from '$lib/components/SideInspector.svelte';
 let datadog = $state<DatadogSnapshot | null>(null);
 let datadogError = $state(false);
 let focusSignals = $state(true);
 let signalView = $state<SignalView>('overview');
 let datadogLoadedAt = $state(0);
 let stats = $state<StatsSnapshot | null>(null);
 let statsError = $state('');
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
  const scoped = snapshot?.mode === 'live' && stats?.scope.environment === 'synthetic' && stats?.scope.deployment === `slot-${snapshot.slot}` && stats?.scope.broker === `soa-s${snapshot.slot}` && stats?.scope.vhost === '/' ? stats : null;
  return Object.fromEntries((snapshot?.systems ?? []).map(s => [s.id, serviceStats(scoped, s.id, Math.max(0,clock-statsLoadedAt), !!statsError)]));
 });
 let layout = $state<MeshLayout | null>(null);
 let failure = $state('');
 let selected = $state<string | null>(null);
 let search = $state('');
 let focused = $state(false);
 let showInspector = $state(true);
 let showList = $state(false);
 let selectedLabel = $derived(snapshot?.systems.find(s => s.id === selected)?.label ?? snapshot?.relationships.find(r => r.id === selected)?.label ?? 'None');
 let matches = $derived(snapshot?.systems.filter(s => s.label.toLowerCase().includes(search.toLowerCase())) ?? []);
 onMount(() => {
  const worker = createLayoutWorker();
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const requests = new Set<AbortController>();
  let statsTimer: ReturnType<typeof setTimeout>;
  let datadogTimer: ReturnType<typeof setTimeout>;
  const clockTimer = setInterval(() => clock = performance.now(), 1000);
  let apiUrl = '/api/mesh';
  let pollMs = 15000;
  const fetchJson = async (url: string) => {
   const request = new AbortController();
   requests.add(request);
   const timeout = setTimeout(() => request.abort(), 10000);
   try {
    const response = await fetch(url, { cache: 'no-store', signal: request.signal });
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
    const nextLayout = !layout || next.topologyVersion !== liveSnapshot?.topologyVersion ? await worker.layout(next) : layout;
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
   let config: { mode?: string; apiUrl?: string; pollIntervalMs?: number } = {};
   if (requested !== 'fixture' && !demo) {
    try { config = await fetchJson('/config.json'); } catch { /* Static fixture builds have no runtime config. */ }
   }
   if (!active) return;
   mode = requested === 'fixture' || demo ? 'fixture' : requested === 'live' || config.mode === 'live' || import.meta.env.VITE_VISHNU_MODE === 'live' ? 'live' : 'fixture';
   if (mode === 'live') {
    apiUrl = config.apiUrl || '/api/mesh';
    pollMs = Math.max(3000, Number(config.pollIntervalMs) || 15000);
    void pollStats();
    void pollDatadog();
    await poll();
   } else {
    try { const result = await worker.layout(demo ? createSignalDemo() : createFixture('overview')); if (active) layout = result; }
    catch (error) { if (active) failure = String(error); }
   }
  };
  void start();
  return () => { active = false; clearTimeout(timer); clearTimeout(statsTimer); clearTimeout(datadogTimer); clearTimeout(hoverTimer); clearInterval(clockTimer); for (const request of requests) request.abort(); worker.terminate(); };
 });
</script>
<svelte:head><title>Vishnu · Saga mesh</title><meta name="description" content="Saga mesh topology, system health, and evidence." /></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape') { clearTimeout(hoverTimer); if (hover) hover = null; else { selected = null; search = ''; } } }} />
<div class="app-shell" class:focused>
 <nav class="app-nav" aria-label="Main"><div class="nav-context"><a class="vishnu-brand" href="/" aria-label="Vishnu home"><img src="/vishnu-logo-on-dark.png" alt="Vishnu — Saga Mesh Observability" width="2172" height="724" /></a></div><a class="active-nav" aria-current="page" href="/">◈ &nbsp; Mesh overview</a><div class="nav-bottom">{sourceLabel}<br/><small>{mode === 'fixture' ? 'Design & interaction study' : 'Local stack health probes'}</small></div></nav>
 <div class="app-main"><header class="topbar"><h1>Preserve, Protect, Anticipate</h1><span class="preview-badge">{sourceLabel}</span></header>
 <main id="mesh-main">
 {#if mode === 'live'}<p class="live-status" role="status">{#if disconnected}{disconnected}. {snapshot ? 'Showing the last observation, marked stale.' : 'Waiting for the local stack collector.'} Retrying automatically.{:else}Local health probes · declared product topology · MQ telemetry {statsError ? 'unavailable' : stats?.receiver.connected ? 'connected' : 'connecting'}{/if} <a href="?mode=fixture">Open fixture preview</a></p>{/if}
 {#if snapshot}
 {#if mode === 'live'}<p class="datadog-status" role="status">Datadog: {datadogError ? 'unavailable; retrying' : datadog?.status ?? 'connecting'}{#if datadog} · {datadog.scope.environment} / {datadog.scope.deployment}{#if !scopedDatadog} · separate scope; graph overlay disabled{/if}{/if}. Metrics describe services; flow analysis opens in Datadog.</p>{/if}
 {#if demo}<div class="demo-banner"><strong>SIMULATED SIGNALS · stand-up demo</strong><span>Invented measurements and call chains. No live APIs or Datadog queries.</span><a href="/">Return to live view ↗</a></div>{:else}<p class="demo-entry"><a href="?mode=demo">Preview simulated signals ↗</a></p>{/if}
 <div class="toolbar">{#if mode === 'live' || demo}<label>Signal view <select bind:value={signalView}><option value="overview">All paths · early warnings</option><option value="hot">Hot services</option><option value="slow">Slow services</option><option value="error">Errors</option><option value="attention">Warnings & alerts</option>{#if demo}<option value="fanout">Fan-out</option>{/if}</select></label><label class="focus-layout-toggle"><input type="checkbox" bind:checked={focusSignals} /> Reflow signal focus</label>{/if}{#if mode === 'fixture' && !demo}<label>Fixture scenario <select bind:value={scenario}><option value="overview">Healthy overview</option><option value="incident">Consumer incident</option><option value="missing">Missing telemetry</option></select></label>{/if}<div class="search"><label for="system-search">Find a system</label><input id="system-search" type="search" placeholder="Search systems…" bind:value={search} />{#if search}<div class="search-results">{#each matches as s}<button onclick={() => { selected = s.id; search = ''; }}>{s.label}</button>{:else}<p>No matching systems</p>{/each}</div>{/if}</div><div class="view-actions"><button aria-pressed={focused} onclick={() => focused = !focused}>{focused ? 'Exit focus' : 'Focus canvas'}</button><button aria-expanded={showInspector} aria-controls="selection-inspector" onclick={() => showInspector = !showInspector}>{showInspector ? 'Hide inspector' : 'Show inspector'}</button><button aria-expanded={showList} aria-controls="mesh-list" onclick={() => showList = !showList}>{showList ? 'Hide list' : 'Browse as list'}</button></div><span class="summary-count">{snapshot.systems.length} systems · {snapshot.relationships.length} paths</span></div>
 {#if demo}<div class="signal-legend" aria-label="Signal legend"><span style="--signal-color:var(--color-attention-strong)">↗ Hot traffic</span><span style="--signal-color:var(--color-primary)">◷ Slow paths</span><span style="--signal-color:var(--chart-2)"><FanoutIcon /> Fan-out</span><span style="--signal-color:var(--color-signal-error)">! Errors / breached threshold</span><small>Intensity = budget used · 35–100% opacity · ▲ early warning from 70% · full connectivity stays visible</small></div>{/if}
 <p class="sr-only" role="status" aria-live="polite">Selected: {selectedLabel}. {showInspector ? 'Details are in the selection inspector.' : 'Use Show inspector for details.'}</p>
 {#if showList}<section class="mesh-list" id="mesh-list" aria-label="Mesh systems and relationships"><div><h3>Systems</h3><ul>{#each snapshot.systems as system}<li><button aria-pressed={selected === system.id} onclick={() => selected = system.id}>{system.label}<small>{system.kind} · {mode === 'live' && system.health === 'healthy' ? 'reachable' : system.health} · {system.freshness}</small></button></li>{/each}</ul></div><div><h3>Relationships</h3><ul>{#each snapshot.relationships as relationship}<li><button aria-pressed={selected === relationship.id} onclick={() => selected = relationship.id}>{relationship.label}<small>{snapshot?.systems.find(s => s.id === relationship.source)?.label} → {snapshot?.systems.find(s => s.id === relationship.target)?.label}<br/>{relationship.kind} · {relationship.health} · {relationship.freshness}</small></button></li>{/each}</ul></div></section>{/if}
 <div class="workspace" class:inspector-hidden={!showInspector}><section class="graph-panel" aria-label="Interactive service mesh"><div class="band-labels"><span>DATA SYSTEMS</span><span>MESH SERVICES</span><span>APPLICATIONS</span></div><div class="graph-canvas">{#if layout}<MeshGraph {focusSignals} demoSignals={demo ? demoSignals : {}} datadog={scopedDatadog} {datadogError} now={datadogNow} {signalView} {snapshot} {layout} {selected} {mqViews} onpreview={preview} onselect={id => { selected = id; hover = null; if (id) showInspector = true; }}/>{:else if failure}<p role="alert">Could not lay out mesh: {failure}</p>{:else}<p role="status">Laying out the mesh…</p>{/if}</div><div class="graph-footer">Drag to pan · Scroll to zoom · Tab then Enter to select<span>Hover path markers for details · signal views reflow with context</span></div></section>{#if showInspector}<SideInspector demoSignals={demo ? demoSignals : {}} {datadog} {datadogError} now={datadogNow} {snapshot} {selected} {mqViews} onselect={id => selected = id}/>{/if}</div>
 {:else}<p role="status">{disconnected || 'Connecting to the mesh…'}</p>{/if}
 </main></div>
</div>

{#if hover}
 <div class="mq-preview nodrag nopan" role="dialog" aria-label="MQ statistics preview" tabindex="-1" style:left={`${hover.x}px`} style:top={`${hover.y}px`} onmouseenter={() => clearTimeout(hoverTimer)} onmouseleave={dismissHover} onfocusin={() => clearTimeout(hoverTimer)} onfocusout={dismissHover}>
  <header><strong>{snapshot?.systems.find(s => s.id === hover?.id)?.label}</strong><button aria-label="Close MQ preview" onclick={() => hover = null}>×</button></header>
  <MqStats view={mqViews[hover.id]} compact />
  <button class="details-button" onclick={() => { selected = hover!.id; showInspector = true; hover = null; }}>Open inspector</button>
 </div>
{/if}
