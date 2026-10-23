<script lang="ts">
 import type { serviceSignal } from '$lib/graph/datadog';
 import {numberLabel, type MqViews} from '$lib/graph/event-stats';
 import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';
 import { systemShape } from '$lib/graph/presentation';
 import { busBadge, busRole, type busParticipants } from '$lib/graph/bus';
 import type { System } from '$lib/graph/types';
 let { data, selected }: NodeProps<Node<{ context?:boolean; width?:number; height?:number; signal: ReturnType<typeof serviceSignal>; mqViews: MqViews; onpreview: (id: string | null, rect?: DOMRect) => void; system: System; dimmed: boolean; live: boolean; participants: ReturnType<typeof busParticipants>; onselect: (id: string) => void }>> = $props();
 let participation = $derived(data.participants.find(p => p.system.id === data.system.id));
 let shape = $derived(systemShape(data.system));
 const symbols = { healthy: '●', warning: '▲', critical: '!', unknown: '?' };
</script>
<div class="system-node {data.system.health} shape-{shape}" style:width={`${data.width ?? 224}px`} style:height={`${data.height ?? 112}px`} class:context-node={data.context} class:chosen={selected} class:dimmed={data.dimmed}>
 {#if shape !== 'service' && !data.context}
  <svg class="node-silhouette" viewBox="0 0 224 112" aria-hidden="true">
   {#if shape === 'database'}
    <path d="M2 16 C2 -2 222 -2 222 16 V96 C222 114 2 114 2 96 Z" />
    <path class="shape-detail" d="M2 16 C2 34 222 34 222 16" />
   {:else if shape === 'cache'}
    <rect x="2" y="2" width="220" height="108" rx="40" />
   {:else}
    <path d="M22 2 H202 L222 22 V90 L202 110 H22 L2 90 V22 Z" />
   {/if}
  </svg>
 {/if}
 <Handle type="target" position={Position.Left} />
 <div class="node-kind">{data.system.kind}</div>
 <strong>{data.system.label}</strong>
 <div class="node-status"><span>{symbols[data.system.health]} {data.live && data.system.runtimeState ? data.system.runtimeState.replace('-', ' ') : data.live && data.system.health === 'healthy' ? 'reachable' : data.system.health}</span><span>{data.system.freshness === 'fresh' ? data.live ? 'probe' : `${data.system.errors ?? '—'} errors` : data.system.freshness}</span></div>
 {#if participation && !data.context}
  <button class="bus-badge nodrag nopan" aria-label={`Inspect event bus participation for ${data.system.label}`} onclick={(event) => { event.stopPropagation(); data.onselect(data.system.id); }} onmouseenter={(event) => data.onpreview(data.system.id, event.currentTarget.getBoundingClientRect())} onmouseleave={() => data.onpreview(null)} onfocus={(event) => data.onpreview(data.system.id, event.currentTarget.getBoundingClientRect())} onblur={() => data.onpreview(null)} aria-haspopup="dialog">{busBadge(participation)}</button>
 {/if}
 {#if !data.context && (data.signal.p95Ms != null || data.signal.rate != null || data.signal.flagged)}
  <div class="apm-badge {data.signal.risk}">APM {data.signal.flagged ? '▲ ' : ''}{data.signal.p95Ms != null ? `p95 ${Math.round(data.signal.p95Ms)} ms` : 'latency —'} · {data.signal.rate != null ? `${numberLabel(data.signal.rate,true)}/s` : 'rate —'}</div>
 {/if}
 <Handle type="source" position={Position.Right} />
</div>

{#if shape === 'bus' && !data.context}
 <section class="bus-panel nodrag nopan" aria-label="RabbitMQ participants">
  <header><strong>Event bus participants</strong><small>MQ-P Publish · MQ-C Consume</small><small>Counts / rate per second</small></header>
  {#each data.participants as participant}
   <div class="bus-participant">
    <button onclick={(event) => { event.stopPropagation(); data.onselect(participant.system.id); }}>{participant.system.label}</button><small class="bus-role">{busBadge(participant)} · {busRole(participant)}</small>
    <div><span>↑ Accepted</span><span>{participant.publishes ? `${numberLabel(data.mqViews[participant.system.id]?.rows[0]?.count ?? null)} / ${numberLabel(data.mqViews[participant.system.id]?.rows[0]?.rate ?? null,true)}` : 'Not declared'}</span></div>
    <div><span>↓ Deliveries</span><span>{participant.consumes ? `${numberLabel(data.mqViews[participant.system.id]?.rows[1]?.count ?? null)} / ${numberLabel(data.mqViews[participant.system.id]?.rows[1]?.rate ?? null,true)}` : 'Not declared'}</span></div>
   </div>
  {:else}<p>No declared participants</p>{/each}
  <footer>— Unknown / unavailable · reporting instances only</footer>
 </section>
{/if}
