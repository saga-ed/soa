<script lang="ts">
 import { signalColor, signalOpacity, signalDegree, signalNames, type DemoSignal } from '$lib/fixtures/signals';
 import { BaseEdge, type EdgeProps, type Edge } from '@xyflow/svelte';
 import type { Point, Relationship } from '$lib/graph/types';
 import { connectionLabel } from '$lib/graph/presentation';
 import { roundedPath } from '$lib/graph/geometry';
 let { id, data, selected }: EdgeProps<Edge<{ relationship: Relationship; demoSignal?: DemoSignal; demo?: boolean; points: Point[]; observed?: boolean; dimmed: boolean }>> = $props();
 let path = $derived(roundedPath(data?.points ?? []));
 let width = $derived(data?.demoSignal ? 4 : data?.relationship.health === 'critical' ? 3 : 1.2);
 let intensity = $derived(data?.demoSignal ? signalOpacity(data.demoSignal) : data?.relationship.health === 'critical' ? 1 : .65);
 let color = $derived(data?.demoSignal ? signalColor(data.demoSignal) : data?.relationship.health === 'critical' ? 'var(--color-signal-error)' : 'var(--color-secondary)');
</script>
<defs><marker id={`arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker></defs>
<g class:dimmed={data?.dimmed} class="mesh-edge" class:edge-selected={selected && !data?.demo}>
 <path d={path} fill="none" stroke="var(--color-bg)" stroke-width={width + 4} style="vector-effect:non-scaling-stroke" />
 <BaseEdge {id} {path} markerEnd={`url(#arrow-${id})`} interactionWidth={24} style={`vector-effect:non-scaling-stroke;${data?.demoSignal ? `filter:drop-shadow(0 0 2px ${color});` : ''}stroke:${color};stroke-width:${width};stroke-opacity:${intensity};${data?.relationship.freshness !== 'fresh' ? 'stroke-dasharray:7 5;' : ''}`} />
</g>
