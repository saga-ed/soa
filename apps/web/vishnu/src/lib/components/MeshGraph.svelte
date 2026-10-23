<script lang="ts">
 import { SvelteFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/svelte';
 import type { MeshSnapshot, MeshLayout } from '$lib/graph/types';
 import { serviceSignal, emphasizes, type DatadogSnapshot, type SignalView } from '$lib/graph/datadog';
 import type { MqViews } from '$lib/graph/event-stats';
 import { busParticipants } from '$lib/graph/bus';
 import SystemNode from './SystemNode.svelte';
 import ConnectionEdge from './ConnectionEdge.svelte';
 import GraphControls from './GraphControls.svelte';
 let { datadog = null, datadogError = false, now = 0, signalView = 'overview', snapshot, layout, selected, onselect, mqViews = {}, onpreview }: { datadog?: DatadogSnapshot | null; datadogError?: boolean; now?: number; signalView?: SignalView; mqViews?: MqViews; onpreview: (id: string | null, rect?: DOMRect) => void; snapshot: MeshSnapshot; layout: MeshLayout; selected: string | null; onselect: (id: string | null) => void } = $props();
 let participants = $derived(busParticipants(snapshot));
 const nodeTypes = { system: SystemNode };
 const edgeTypes = { routed: ConnectionEdge };
 let relevant = $derived.by(() => {
  const ids = new Set<string>();
  if (!selected) return ids;
  ids.add(selected);
  for (const r of snapshot.relationships) if (r.id === selected || r.source === selected || r.target === selected || r.via?.includes(selected)) {
   ids.add(r.id); ids.add(r.source); ids.add(r.target);
   for (const intermediary of r.via ?? []) ids.add(intermediary);
  }
  return ids;
 });
 let nodes: Node[] = $derived(layout.nodes.map(n => {
  const system = snapshot.systems.find(s => s.id === n.id)!;
  const signal = serviceSignal(datadog, system.id, now, datadogError);
  return { id: n.id, type: 'system', position: { x: n.x, y: n.y }, width: n.width, height: n.height, selected: selected === n.id, ariaLabel: `${system.label}, ${snapshot.mode === 'live' && system.health === 'healthy' ? 'reachable' : system.health}. Press Enter to inspect.`, data: { system, signal, participants, onselect, mqViews, onpreview, live: snapshot.mode === 'live', dimmed: selected ? !relevant.has(n.id) : !emphasizes(signalView, signal) } };
 }));
 let edges: Edge[] = $derived(layout.edges.filter(e => snapshot.relationships.find(r => r.id === e.id)?.kind !== 'event').map(e => {
  const r = snapshot.relationships.find(r => r.id === e.id)!;
  const sourceSignal = serviceSignal(datadog, r.source, now, datadogError);
  const targetSignal = serviceSignal(datadog, r.target, now, datadogError);
  const emphasized = emphasizes(signalView, sourceSignal) || emphasizes(signalView, targetSignal);
  const observed = !datadogError && datadog && ['connected','partial'].includes(datadog.status) && now - Date.parse(datadog.observedAt) <= datadog.freshForMs && datadog.dependencies.some(d => d.source === r.source && d.target === r.target);
  return { id: e.id, source: r.source, target: r.target, type: 'routed', selected: selected === e.id, ariaLabel: `${r.label}, ${r.kind}, ${r.health}. Press Enter to inspect.`, data: { relationship: r, points: e.points, observed: !!observed, dimmed: selected ? !relevant.has(e.id) : !emphasized } };
 }));
 let selectedIds = $derived(snapshot.systems.some(s => s.id === selected) ? [selected!] : snapshot.relationships.filter(r => r.id === selected).flatMap(r => [r.source, r.target]));
</script>
<SvelteFlow {nodes} {edges} {nodeTypes} {edgeTypes} fitView minZoom={0.15} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable deleteKey={null} onnodeclick={({ node }) => onselect(node.id)} onedgeclick={({ edge }) => onselect(edge.id)} onselectionchange={({ nodes: ns, edges: es }) => { const id = ns[0]?.id ?? es[0]?.id; if (id && id !== selected) onselect(id); }} onpaneclick={() => onselect(null)}>
 <Background />
 <GraphControls {selectedIds} />
 <Controls showLock={false} />
 <MiniMap pannable zoomable nodeColor="var(--color-primary-light)" nodeStrokeColor="var(--color-primary)" />
</SvelteFlow>
