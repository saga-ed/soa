<script lang="ts">
 import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';
 import { systemShape } from '$lib/graph/presentation';
 import { busBadge, busRole, type busParticipants } from '$lib/graph/bus';
 import type { System } from '$lib/graph/types';
 let { data, selected }: NodeProps<Node<{ system: System; dimmed: boolean; live: boolean; participants: ReturnType<typeof busParticipants>; onselect: (id: string) => void }>> = $props();
 let participation = $derived(data.participants.find(p => p.system.id === data.system.id));
 let shape = $derived(systemShape(data.system));
 const symbols = { healthy: '●', warning: '▲', critical: '!', unknown: '?' };
</script>
<div class="system-node {data.system.health} shape-{shape}" class:chosen={selected} class:dimmed={data.dimmed}>
 {#if shape !== 'service'}
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
 {#if participation}
  <button class="bus-badge nodrag nopan" aria-label={`Inspect event bus participation for ${data.system.label}`} onclick={(event) => { event.stopPropagation(); data.onselect(data.system.id); }} title={busRole(participation)}>{busBadge(participation)}</button>
 {/if}
 <Handle type="source" position={Position.Right} />
</div>

{#if shape === 'bus'}
 <section class="bus-panel nodrag nopan" aria-label="RabbitMQ participants">
  <header><strong>Event bus participants</strong><small>MQ-P Publish · MQ-C Consume</small><small>Counts / rate per second</small></header>
  {#each data.participants as participant}
   <div class="bus-participant">
    <button onclick={(event) => { event.stopPropagation(); data.onselect(participant.system.id); }}>{participant.system.label}</button><small class="bus-role">{busBadge(participant)} · {busRole(participant)}</small>
    <div><span>↑ Published</span><span>{participant.publishes ? '— / —' : 'Not declared'}</span></div>
    <div><span>↓ Consumed</span><span>{participant.consumes ? '— / —' : 'Not declared'}</span></div>
   </div>
  {:else}<p>No declared participants</p>{/each}
  <footer>— Unknown · telemetry not connected</footer>
 </section>
{/if}
