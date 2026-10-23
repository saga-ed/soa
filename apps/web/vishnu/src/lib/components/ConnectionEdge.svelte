<script lang="ts">
 import { signalColor, signalOpacity, signalDegree, signalNames, type DemoSignal } from '$lib/fixtures/signals';
 import { BaseEdge, EdgeLabel, useStore, type EdgeProps, type Edge } from '@xyflow/svelte';
 import type { Point, Relationship } from '$lib/graph/types';
 import { connectionLabel } from '$lib/graph/presentation';
 import { roundedPath } from '$lib/graph/geometry';
 let { id, data, selected }: EdgeProps<Edge<{ relationship: Relationship; demoSignal?: DemoSignal; demo?: boolean; points: Point[]; observed?: boolean; dimmed: boolean }>> = $props();
 const store = useStore();
 let midpoint = $derived.by(() => { const p = data?.points ?? []; const lengths = p.slice(1).map((b, i) => Math.hypot(b.x-p[i].x,b.y-p[i].y)); let half=lengths.reduce((a,b)=>a+b,0)/2; for(let i=0;i<lengths.length;i++){if(half<=lengths[i]){const t=lengths[i] ? half/lengths[i] : 0;return {x:p[i].x+(p[i+1].x-p[i].x)*t,y:p[i].y+(p[i+1].y-p[i].y)*t};}half-=lengths[i];}return p[0] ?? {x:0,y:0}; });
 let trouble = $derived(data?.relationship.health === 'warning' || data?.relationship.health === 'critical');
 let showLabel = $derived(selected || data?.relationship.kind === 'http' || store.viewport.zoom >= 0.65 || trouble);
 let path = $derived(roundedPath(data?.points ?? []));
 let width = $derived(data?.demoSignal ? 7 : data?.demo ? 2 : 1.5 + Math.min(5, Math.sqrt(data?.relationship.count ?? 1)));
 let intensity = $derived(data?.demoSignal ? signalOpacity(data.demoSignal) : data?.demo ? .3 : data?.relationship.rate == null ? 0.5 : 0.5 + 0.5 * Math.min(1, data.relationship.rate / 100));
 let color = $derived(data?.demoSignal ? signalColor(data.demoSignal) : data?.demo ? 'var(--color-secondary)' : 'var(--color-primary)');
</script>
<defs><marker id={`arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker></defs>
<g class:dimmed={data?.dimmed} class="mesh-edge" class:edge-selected={selected && !data?.demo}>
 <path d={path} fill="none" stroke="var(--color-bg)" stroke-width={width + 5} />
 <BaseEdge {id} {path} markerEnd={`url(#arrow-${id})`} interactionWidth={24} style={`stroke:${color};stroke-width:${width};stroke-opacity:${intensity};${data?.relationship.freshness !== 'fresh' ? 'stroke-dasharray:7 5;' : ''}`} />
</g>

{#if data && showLabel}
<EdgeLabel x={midpoint.x} y={midpoint.y} selectEdgeOnClick class={`connection-label ${data.relationship.health} ${data.dimmed ? 'dimmed' : ''}`}><span>{#if data.demoSignal}<span class="signal-edge-label" style:color={color}>{signalDegree(data.demoSignal) >= .7 ? '▲ ' : ''}{signalNames[data.demoSignal.kind]} · {data.demoSignal.value} {data.demoSignal.unit} · {Math.round(signalDegree(data.demoSignal)*100)}%</span>{:else}{data.relationship.health === 'critical' ? '! ' : data.relationship.health === 'warning' ? '▲ ' : ''}{connectionLabel(data.relationship)}{data.observed ? ' · observed' : ''}{selected ? ` · ${data.relationship.label}` : ''}{/if}</span></EdgeLabel>
{/if}
