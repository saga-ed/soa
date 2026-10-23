<script lang="ts">
 import { signalNames, signalColor, signalDegree, type DemoSignal } from '$lib/fixtures/signals';
 import DatadogStats from './DatadogStats.svelte';
 import type { DatadogSnapshot } from '$lib/graph/datadog';
 import MqStats from './MqStats.svelte';
 import type { MqViews } from '$lib/graph/event-stats';
 import { connectionLabel } from '$lib/graph/presentation';
 import type { MeshSnapshot } from '$lib/graph/types';
 let { demoSignals = {}, datadog = null, datadogError = false, now = 0, snapshot, selected, onselect, mqViews = {} }: { demoSignals?: Record<string, DemoSignal>; datadog?: DatadogSnapshot | null; datadogError?: boolean; now?: number; mqViews?: MqViews; snapshot: MeshSnapshot; selected: string | null; onselect: (id: string | null) => void } = $props();
 let item = $derived(snapshot.systems.find(s => s.id === selected) ?? snapshot.relationships.find(r => r.id === selected));
 let relationships = $derived(snapshot.relationships.filter(r => r.source === selected || r.target === selected || (selected != null && r.via?.includes(selected))));
 let expanded = $state(false);
 $effect(() => { selected; expanded = false; });
</script>
<aside id="selection-inspector" class="inspector" aria-label="Selection inspector">
 <div class="inspector-heading"><span class="eyebrow">INSPECTOR</span>{#if item}<button aria-label="Clear selection" onclick={() => onselect(null)}>×</button>{/if}</div>
 {#if item}
  <h2>{item.label}</h2><div class="status-pill {item.health}">{snapshot.mode === 'live' && item.health === 'healthy' ? 'reachable' : item.health} · {item.freshness}</div>
  {#if item && !('source' in item) && ((item.band === 'mesh' && !item.id.startsWith('infra:')) || item.eventBus || relationships.some(r => r.kind === 'event'))}
   <h3>MQ activity</h3>
   {#if item.eventBus}<p>{item.eventBus.publishes ? 'MQ-P · Publishes events' : ''}{item.eventBus.publishes && item.eventBus.consumes ? ' · ' : ''}{item.eventBus.consumes ? 'MQ-C · Consumes events' : ''}</p>{/if}
   <MqStats view={mqViews[item.id]} />
   <div class="relationship-list">{#each relationships.filter(r => r.kind === 'event') as r}<button onclick={() => onselect(r.id)}><strong>{r.source === selected ? '↑ Publishes' : r.target === selected ? '↓ Consumes' : '↔ Routes'}: {r.label}</strong><small>{snapshot.systems.find(s => s.id === r.source)?.label} → {snapshot.systems.find(s => s.id === r.target)?.label}</small></button>{/each}</div>
   <p>Message consumption does not establish successful projection completion.</p>
  {/if}
  {#if snapshot.mode === 'live' && ('source' in item ? item.kind === 'http' : item.band !== 'data')}
   <DatadogStats data={datadog} failed={datadogError} {now} source={'source' in item ? item.source : item.id} target={'target' in item ? item.target : undefined} />
  {/if}
  {#if demoSignals[item.id]}{@const signal = demoSignals[item.id]}<section class="demo-detail" style:border-color={signalColor(signal)}><strong>SIMULATED · {signalNames[signal.kind]}</strong><h3>{signal.value} {signal.unit}</h3><p>{Math.round(signalDegree(signal)*100)}% of a {signal.budget} {signal.unit} budget.</p><p>{signal.detail}</p><p>Warning at 70%; breach at 100%. Color intensity increases as headroom shrinks.</p></section>{/if}
  <p>{item.summary}</p>
  <dl class="metrics">
   <div><dt>Type</dt><dd>{'source' in item ? connectionLabel(item) : item.kind}</dd></div>
   {#if 'rate' in item}<div><dt>Traffic</dt><dd>{item.rate == null ? 'Unknown' : `${item.rate}/s`}</dd></div>{#if item.kind === 'http'}<div><dt>p95 latency</dt><dd>{item.latencyMs == null ? 'Unknown' : `${item.latencyMs} ms`}</dd></div>{/if}<div><dt>{item.kind === 'event' ? 'Distinct event types' : item.kind === 'http' ? 'Endpoints' : 'Database operations'}</dt><dd>{item.count ?? 'Unknown'}</dd></div>{:else}<div><dt>Observed errors</dt><dd>{item.errors == null ? 'Unknown' : `${item.errors}`}</dd></div>{/if}
  </dl>
  <h3>Evidence</h3>{#each item.evidence as evidence}<section class="evidence"><strong>{evidence.label}</strong><p>{evidence.description}</p>{#if evidence.url && /^https?:\/\//.test(evidence.url)}<a href={evidence.url} target="_blank" rel="noreferrer">Open evidence ↗</a>{/if}</section>{/each}
  {#if !item.evidence.length}<p>No evidence supplied. Unknown does not mean healthy.</p>{/if}
  <button class="details-button" aria-expanded={expanded} onclick={() => expanded = !expanded}>{expanded ? 'Hide' : 'Show'} relationship details</button>
  {#if expanded}
   {#if 'source' in item}<div class="relationship-list"><button onclick={() => onselect(item && 'source' in item ? item.source : null)}>Source: {snapshot.systems.find(s => 'source' in item! && s.id === item!.source)?.label}</button><button onclick={() => onselect(item && 'target' in item ? item.target : null)}>Target: {snapshot.systems.find(s => 'target' in item! && s.id === item!.target)?.label}</button></div>
   {:else}<div class="relationship-list">{#each relationships as r}<button onclick={() => onselect(r.id)}><strong>{r.label}</strong><small>{r.kind} · {r.health} · {r.freshness}</small></button>{/each}</div>{/if}
  {/if}
 {:else}
  {#if Object.keys(demoSignals).length}<h2>Early warnings</h2><p>All paths stay visible. These simulated signals approach their budgets before errors appear.</p><div class="relationship-list">{#each Object.entries(demoSignals).filter(([,s]) => signalDegree(s) >= .7) as [id,signal]}<button class="demo-warning" style:border-left-color={signalColor(signal)} onclick={() => onselect(id)}><strong>{signalNames[signal.kind]} · {Math.round(signalDegree(signal)*100)}% of budget</strong><small>{snapshot.relationships.find(r => r.id === id)?.label}<br/>{signal.value} {signal.unit}</small></button>{/each}</div><p>Example: IAM → Programs ×2 → Scheduling ×25 = 50 Scheduling calls per IAM request.</p>{/if}
  <h2>Follow the signal</h2><p>Select a system or connection to inspect its health and evidence without losing your place.</p>
  <h3>Systems needing attention</h3><div class="relationship-list">{#each snapshot.systems.filter(s => s.health !== 'healthy') as s}<button onclick={() => onselect(s.id)}><strong>{s.label}</strong><small>{s.health} · {s.freshness}</small></button>{:else}<p>{snapshot.mode === 'live' ? 'All probed systems are reachable.' : 'All fixture systems are healthy.'}</p>{/each}</div>
  <h3>Reading the mesh</h3><p>Border + status: system health.<br/>Strong colored lines: signals. Thin gray lines: structure.<br/>Orange: hot traffic. Blue: slow paths. Red: errors. Magenta: fan-out.<br/>Dashed lines: stale or missing telemetry.<br/>Labels: HTTP/tRPC, HTTP/REST, HTTP/tRPC + REST, HTTP/? (unverified), DB; ▲ or ! marks trouble.</p><p>Signal views expand matching systems while retaining a smaller context mesh. Turn off Reflow signal focus to preserve the full layout. APM badges show service-level metrics; hot traffic alone does not imply a fault. White gaps at crossings mean paths cross without connecting. MQ badges and the RabbitMQ participant panel expose logical publisher-to-consumer relationships; event edges are hidden.</p>
 {/if}
 <p class="fixture-note">Observation: <time datetime={snapshot.observedAt}>{new Date(snapshot.observedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</time><br/>{#if snapshot.mode === 'fixture'}Metrics and observed error counts cover the preceding {snapshot.observationWindowSeconds / 60} minutes.{:else}Health reflects local probes at this observation time. A successful probe does not establish end-to-end service health.{/if}</p>
 <p class="fixture-note">{#if snapshot.mode === 'fixture'}Invented fixture evidence. No live telemetry is connected.{:else}Declared relationships come from the local stack configuration. MQ statistics are reported by participating services. APM service observations are shown separately from local probes. Edge traffic and latency remain unknown without caller-specific evidence. Endpoint counts remain unknown.{/if}</p>
</aside>
