<script lang="ts">
 import { serviceSignal, traceLink, type DatadogSnapshot } from '$lib/graph/datadog';
 import EndpointStats from './EndpointStats.svelte';
 import { numberLabel } from '$lib/graph/event-stats';
 let { data, source, target, now, failed = false }: { data: DatadogSnapshot | null; source: string; target?: string; now: number; failed?: boolean } = $props();
 let signal = $derived(serviceSignal(data, target ?? source, now, failed));
 let retained = $derived(data?.measurementSource === 'retained-spans');
 let fresh = $derived(!!data && !failed && ['connected', 'partial'].includes(data.status) && now - Date.parse(data.observedAt) <= data.freshForMs);
 let observedSpans = $derived(fresh ? data?.services.find(s => s.service === (target ?? source))?.observedSpans ?? null : null);
</script>
<section class="datadog-stats" aria-label="Datadog observations">
 <h3>Datadog APM</h3>
 {#if data}
  <p class="fixture-note">{data.scope.environment} / {data.scope.deployment}{#if data.scope.machine} / {data.scope.machine}{/if} · {failed ? 'unavailable' : now - Date.parse(data.observedAt) > data.freshForMs ? 'stale' : data.status}<br/>Window: {new Date(data.window.from).toLocaleTimeString()}–{new Date(data.window.to).toLocaleTimeString()}</p>
  <EndpointStats {data} {source} {target} {now} {failed} />
  <h4>{target ? 'Destination service overview' : 'Service overview'}</h4>
  {#if target}<p>Destination service: <strong>{target}</strong>. These metrics include all callers; they are not measurements of this individual path.</p>{/if}
  <dl class="metrics">
   {#if retained}
    <div><dt>Observed server spans</dt><dd>{numberLabel(observedSpans)}</dd></div>
    <div><dt>Retained-span p95</dt><dd>{numberLabel(signal.p95Ms)} ms</dd></div>
   {:else}
    <div><dt>Request rate</dt><dd>{numberLabel(signal.rate,true)} /s</dd></div>
    <div><dt>Latest p95 bucket</dt><dd>{numberLabel(signal.p95Ms)} ms</dd></div>
    <div><dt>Error rate</dt><dd>{numberLabel(signal.errorRate,true)} /s</dd></div>
    <div><dt>p95 five minutes earlier</dt><dd>{numberLabel(signal.previousP95Ms)} ms</dd></div>
   {/if}
  </dl>
  <p class="fixture-note">{#if retained}Service counts and latency describe retained spans in the APM window. They do not establish total throughput or population latency.{:else}Display thresholds: hot ≥ {data.thresholds.hotRate}/s;{/if} p95 warning ≥ {data.thresholds.warningP95Ms} ms, critical ≥ {data.thresholds.criticalP95Ms} ms. These are display thresholds, not a sustained Datadog monitor evaluation.</p>
  {#each signal.monitors as monitor}<p><a href={monitor.url} target="_blank" rel="noreferrer">{monitor.status}: {monitor.name}{monitor.actionable === false ? ' (composite input; not a standalone alert)' : ''} ↗</a></p>{/each}
  {#if !signal.monitors.length}<p class="fixture-note">No current monitor groups matched this observation scope.</p>{/if}
  <a class="details-button" href={traceLink(data,source,target)} target="_blank" rel="noreferrer">{target ? 'Investigate this call in Datadog' : 'Open service traces in Datadog'} ↗</a>
  {#if target}<p><a href={traceLink(data,target)} target="_blank" rel="noreferrer">Open destination traces ↗</a></p>{/if}
  <p class="fixture-note">Use Datadog’s Trace Queries / Flow Map for repeated calls, fan-out and waterfalls. The call link filters outgoing client spans by peer service; missing instrumentation or peer tags can yield no results. Retained spans are sampled evidence, not total request counts.</p>
  <p class="fixture-note">{data.message}</p>
 {:else}<p>Datadog observations unavailable. Local probes and MQ statistics remain independent.</p>{/if}
</section>
