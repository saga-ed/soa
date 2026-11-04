<script lang="ts">
 import type { DatadogSnapshot, SignalView } from '$lib/graph/datadog';
 import { rankOffenders, normalizeTopN } from '$lib/graph/offenders';
 let { data, source, target, view, topN, now, failed = false, supported = true }: { data: DatadogSnapshot | null; source: string; target: string; view: SignalView; topN: number; now: number; failed?: boolean; supported?: boolean } = $props();
 let ranking = $derived(rankOffenders(data, source, target, view, topN, now, failed, supported));
 let counterRates = $derived(ranking.rows.some(row=>row.basis==='counter-rate'));
 let label = $derived(view === 'slow' ? 'Slow' : view === 'hot' ? 'Hot' : 'Fan-out');
 const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
</script>
<section class="offenders" aria-label="Ranked path endpoints">
 <h3>Top {normalizeTopN(topN)} · {label} endpoints</h3>
 <p class="path">{source} → {target}</p>
 {#if ranking.state === 'unsupported'}
  <p>Endpoint ranking is unavailable for this connection type. HTTP caller-to-callee evidence is required.</p>
 {:else if ranking.state === 'unavailable'}
  <p>Path-specific {view === 'fanout' ? 'fan-out samples' : 'endpoint measurements'} unavailable for this scope. Service-wide statistics cannot rank this path.</p>
 {:else if ranking.state === 'stale'}
  <p>Path measurements are stale. Rankings will return after fresh observations arrive.</p>
 {:else if ranking.state === 'empty'}
  <p>No {view === 'fanout' ? 'attributable sampled parent requests' : 'measured endpoints'} for this path in the observation window. This does not establish zero traffic.</p>
 {:else}
  {#if ranking.state === 'partial'}<p>Partial coverage: limited to returned measurements and sampled traces.</p>{/if}
  <p>{view === 'fanout' ? 'Ranked by mean outgoing calls per sampled parent request traversing this path.' : view === 'slow' ? 'Ranked by retained outgoing client-span p95 duration.' : counterRates ? 'Ranked by requests/sec from application counters of completed HTTP attempts, including failed outcomes.' : 'Request rates unavailable. Ranked by retained outgoing client-span count, not total traffic or requests per second.'}</p>
  <ol>
   {#each ranking.rows as row}
    <li><strong>{row.resource}</strong>{#if row.parentResource}<small>Parent: {row.parentResource}</small>{/if}<span class="rank-value">{number(row.value)} {view === 'slow' ? 'ms p95' : view === 'hot' ? counterRates ? 'req/s' : 'retained calls' : 'calls / sampled parent'}</span><small>{#if view === 'fanout'}{number(row.observedCalls)} calls · {number(row.sampledParents!)} sampled parents · max {number(row.maxCallsPerParent!)} calls / parent{:else if counterRates}{number(row.observedCalls)} counted HTTP attempts{:else}{number(row.observedCalls)} retained client spans{/if}</small></li>
   {/each}
  </ol>
  <p>Showing {ranking.rows.length} of {ranking.total} measured endpoint{ranking.total === 1 ? '' : 's'} on this path.</p>
 {/if}
 {#if data && !['unavailable', 'unsupported', 'stale'].includes(ranking.state)}
  {#if view === 'fanout' && data.fanoutCoverage}<p>Bounded recent retained-trace sample: {data.fanoutCoverage.usableTraces} usable / {data.fanoutCoverage.retrievedTraces} retrieved traces ({data.fanoutCoverage.requestedTraces} requested; {data.fanoutCoverage.rejectedTraces} rejected). Ranking covers only this sample; it is not fleet-wide fan-out.</p>{:else if counterRates}<p>Coverage includes only endpoints with verified counter buckets. Missing endpoints are unknown, not zero.</p>{:else if data.pathEndpointLimited}<p>Endpoint coverage is limited to returned aggregate groups.</p>{/if}
  <p class="scope">{data.scope.environment} · {data.scope.deployment}{data.scope.machine ? ` · ${data.scope.machine}` : ''}<br/>{new Date(counterRates ? data.pathRateWindow!.from : data.window.from).toISOString()} – {new Date(counterRates ? data.pathRateWindow!.to : data.window.to).toISOString()}</p>
 {/if}
</section>
<style>
 .offenders { margin-block:14px; padding:12px; background:var(--color-bg); border:1px solid var(--color-border-strong); border-radius:6px; }
 h3 { margin-top:0; } p, small { font-size:11px; line-height:1.5; } .path { overflow-wrap:anywhere; }
 ol { padding-left:20px; } li { padding:8px 0; border-bottom:1px solid var(--color-border); }
 strong, small, .rank-value { display:block; overflow-wrap:anywhere; } strong {font-size:12px;} .rank-value { font-size:14px; margin:4px 0; } .scope { opacity:.7; overflow-wrap:anywhere; }
</style>
