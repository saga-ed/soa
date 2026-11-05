<script lang="ts">
 import { eventRates } from '$lib/graph/event-rates';
 import type { ServiceStats } from '$lib/graph/event-stats';
 let {view,role}: {view?:ServiceStats;role?:'producer'|'consumer'}=$props();
 let rows=$derived(eventRates(view,role));
</script>
<section class="event-rates" aria-label="Event counter rates">
 <p><strong>{role==='producer'?'Service → bus':role==='consumer'?'Bus → service':'Event counter rates'}</strong> · {view?.status??'No reports'}</p>
 <div>{#each rows as row}<span>{row.labelled}{#if row.coverage?.partial} · partial{/if}</span>{/each}</div>
 <p>Service totals from counter deltas. Accepted and confirmed publishes, deliveries, commits and retry actions are separate measurements; differences do not establish backlog.</p>
 {#if view?.scope}<p class="scope">{view.scope.environment} / {view.scope.deployment} · {view.scope.broker} · vhost {view.scope.vhost}</p>{/if}
 {#each rows.filter(r=>r.coverage?.windows.length) as row}
  <details><summary>{row.label}: {row.coverage!.measuredInstances}/{row.coverage!.totalInstances} instances · {row.coverage!.aligned?'aligned interval':'per-instance intervals'}</summary>{#each row.coverage!.windows as window}<p>{window.instance}: {new Date(window.from).toLocaleTimeString()}–{new Date(window.to).toLocaleTimeString()} ({window.intervalMs/1000}s)</p>{/each}</details>
 {/each}
 <p>— Unknown · 0 Measured idle. {view?.staleAfterMs ? `Reports expire after ${view.staleAfterMs/1000}s.` : ''}</p>
</section>
<style>
 .event-rates { padding:10px; border:1px solid var(--color-border); border-radius:4px; margin-block:10px; } p,summary {font-size:var(--vishnu-ui-font-size);line-height:1.5;margin-bottom:6px} div {display:flex;flex-wrap:wrap;gap:6px 12px;font-size:var(--vishnu-ui-font-size);margin-bottom:8px} .scope {color:var(--color-text-secondary)} details p {overflow-wrap:anywhere}
</style>
