<script lang="ts">
 import { measurements, numberLabel, type ServiceStats } from '$lib/graph/event-stats';
 let {view, compact = false}: {view?: ServiceStats; compact?: boolean} = $props();
</script>
<section class="mq-stats" aria-label="MQ statistics">
 <div class="mq-freshness"><strong>{view?.status ?? 'No reports'}</strong>{#if view?.fresh.length}<span>{view.fresh.length} reporting instance{view.fresh.length === 1 ? '' : 's'}</span>{/if}</div>
 {#if view?.latestReceivedAt}<p class="mq-caption">Last report <time datetime={view.latestReceivedAt}>{new Date(view.latestReceivedAt).toLocaleTimeString()}</time></p>{/if}
 {#if view?.fresh.length}
 <table><thead><tr><th>Measurement</th><th>Count</th><th>/ sec</th></tr></thead><tbody>
 {#each compact ? view.rows.slice(0,5) : view.rows as row}<tr><th>{row.label}</th><td>{numberLabel(row.count)}</td><td>{numberLabel(row.rate,true)}</td></tr>{/each}
 </tbody></table>
 <p class="mq-caption">{#if compact}Since process start · rates over the latest report interval.{:else}Counts since process start, summed across reporting instances. Rates use each instance’s latest measured interval.{/if}</p>
 {:else}<p>{view?.status === 'Unavailable' ? 'Statistics API unavailable. Retained reports are not treated as current.' : view?.status === 'Stale' ? 'Reports have expired. Current counts and rates are unknown.' : 'This service has not reported MQ statistics in this scope.'}</p>{/if}
 {#if view?.stale}<p class="mq-caption">{view.stale} stale instance{view.stale === 1 ? '' : 's'} excluded from totals.</p>{/if}
 <p class="mq-caption">— Unavailable · 0 Measured idle{#if !compact}<br/>Transport acceptance is not broker confirmation. Deliveries include duplicates; committed work excludes them. Fan-out counts are per subscription.{/if}</p>
 {#if !compact && view?.sources.length}
 <h4>Instances and streams</h4>
 {#each view.sources as source}
 <details class="mq-source"><summary>{source.report.identity.instance} · {view.fresh.includes(source) ? 'live' : 'stale'}</summary>
 <p class="mq-caption">Received {new Date(source.receivedAt).toLocaleString()}<br/>Epoch {source.report.epoch}<br/>Revision {source.report.identity.revision} · report {source.report.sequence}</p>
 {#if Object.values(source.report.diagnostics).some(n => n > 0)}<p class="mq-caption">Reporting diagnostics: {Object.entries(source.report.diagnostics).filter(([,n]) => n > 0).map(([key,n]) => `${key}: ${n}`).join(' · ')}</p>{/if}
 <p class="mq-caption">Historical counters below belong to this process epoch. Stream-to-graph mapping is unverified.</p>
 {#each source.report.streams as entry}
 <details class="mq-stream"><summary>{entry.stream.eventType} · v{entry.stream.eventVersion ?? '?'}</summary>
 <p class="mq-caption">{entry.stream.role} · {entry.stream.exchange}<br/>{entry.stream.consumer ?? ''}{entry.stream.queue ? ` · queue ${entry.stream.queue}` : ''}</p>
 <dl>{#each measurements.filter(m => m.role === entry.stream.role) as m}<div><dt>{m.label}</dt><dd>{numberLabel(entry.counters[m.key])}</dd></div>{/each}</dl>
 {#if Object.values(entry.failureReasons).some(n => n > 0)}<p class="mq-caption">Failures: {Object.entries(entry.failureReasons).filter(([,n]) => n > 0).map(([key,n]) => `${key}: ${n}`).join(' · ')}</p>{/if}
 </details>
 {/each}
 </details>
 {/each}
 {/if}
</section>
