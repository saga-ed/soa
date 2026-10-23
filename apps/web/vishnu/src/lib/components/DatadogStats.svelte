<script lang="ts">
 import { serviceSignal, traceLink, type DatadogSnapshot } from '$lib/graph/datadog';
 import { numberLabel } from '$lib/graph/event-stats';
 let { data, source, target, now, failed = false }: { data: DatadogSnapshot | null; source: string; target?: string; now: number; failed?: boolean } = $props();
 let signal = $derived(serviceSignal(data, target ?? source, now, failed));
</script>
<section class="datadog-stats" aria-label="Datadog observations">
 <h3>Datadog APM</h3>
 {#if data}
  <p class="fixture-note">{data.scope.environment} / {data.scope.deployment} · {failed ? 'unavailable' : now - Date.parse(data.observedAt) > data.freshForMs ? 'stale' : data.status}<br/>Window: {new Date(data.window.from).toLocaleTimeString()}–{new Date(data.window.to).toLocaleTimeString()}</p>
  {#if target}<p>Destination service: <strong>{target}</strong>. These metrics include all callers; they are not measurements of this individual path.</p>{/if}
  <dl class="metrics">
   <div><dt>Request rate</dt><dd>{numberLabel(signal.rate,true)} /s</dd></div>
   <div><dt>Latest p95 bucket</dt><dd>{numberLabel(signal.p95Ms)} ms</dd></div>
   <div><dt>Error rate</dt><dd>{numberLabel(signal.errorRate,true)} /s</dd></div>
   <div><dt>p95 five minutes earlier</dt><dd>{numberLabel(signal.previousP95Ms)} ms</dd></div>
  </dl>
  <p class="fixture-note">Display thresholds: hot ≥ {data.thresholds.hotRate}/s; p95 warning ≥ {data.thresholds.warningP95Ms} ms, critical ≥ {data.thresholds.criticalP95Ms} ms. These highlight the latest bucket, not a sustained Datadog monitor evaluation.</p>
  {#each signal.monitors as monitor}<p><a href={monitor.url} target="_blank" rel="noreferrer">{monitor.status}: {monitor.name}{monitor.actionable === false ? ' (composite input; not a standalone alert)' : ''} ↗</a></p>{/each}
  {#if !signal.monitors.length}<p class="fixture-note">No current monitor groups matched this observation scope.</p>{/if}
  <a class="details-button" href={traceLink(data,source,target)} target="_blank" rel="noreferrer">{target ? 'Investigate this call in Datadog' : 'Open service traces in Datadog'} ↗</a>
  {#if target}<p><a href={traceLink(data,target)} target="_blank" rel="noreferrer">Open destination traces ↗</a></p>{/if}
  <p class="fixture-note">Use Datadog’s Trace Queries / Flow Map for repeated calls, fan-out and waterfalls. The call link filters by parent service; missing propagation or parent tags can yield no results. Retained spans are sampled evidence, not total request counts.</p>
  <p class="fixture-note">{data.message}</p>
 {:else}<p>Datadog observations unavailable. Local probes and MQ statistics remain independent.</p>{/if}
</section>
