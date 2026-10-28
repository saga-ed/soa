<script lang="ts">
 import { untrack, onDestroy } from 'svelte';
 import { focusLayout, layoutTween } from '$lib/graph/focus-layout';
 import GraphLabels from './GraphLabels.svelte';
 import { SvelteFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/svelte';
 import type { MeshSnapshot, MeshLayout } from '$lib/graph/types';
 import { serviceSignal, emphasizes, type DatadogSnapshot, type SignalView } from '$lib/graph/datadog';
 import { signalDegree, type DemoSignal } from '$lib/fixtures/signals';
 import type { MqViews } from '$lib/graph/event-stats';
 import { busParticipants } from '$lib/graph/bus';
 import SystemNode from './SystemNode.svelte';
 import ConnectionEdge from './ConnectionEdge.svelte';
 import GraphControls from './GraphControls.svelte';
 let { focusSignals = true, demoSignals = {}, datadog = null, datadogError = false, now = 0, signalView = 'overview', snapshot, layout, selected, onselect, mqViews = {}, onpreview }: { focusSignals?: boolean; demoSignals?: Record<string, DemoSignal>; datadog?: DatadogSnapshot | null; datadogError?: boolean; now?: number; signalView?: SignalView; mqViews?: MqViews; onpreview: (id: string | null, rect?: DOMRect) => void; snapshot: MeshSnapshot; layout: MeshLayout; selected: string | null; onselect: (id: string | null) => void } = $props();
 let participants = $derived(busParticipants(snapshot));
 const demoMatch = (s: DemoSignal) => signalView === 'overview' || (signalView === 'attention' ? signalDegree(s) >= .7 : signalView === s.kind);
 let displayLayout = $state<MeshLayout|null>(null);
 let targetLayout = $state<MeshLayout|null>(null);
 let revision = $state(0);
 let moving = $state(false);
 let focusCount = $state(0);
 let manualFocus = $state<{view:SignalView;ids:string[]}|null>(null);
 let frame = 0;
 let lastFocusRequest = '';
 let drawn = $derived(displayLayout ?? layout);
 const matched = () => {
  const ids=new Set<string>();
  if(signalView === 'overview') return ids;
  for(const r of snapshot.relationships.filter(r=>r.kind==='http'||r.kind==='dependency')) {
   const demo=demoSignals[r.id];
   const match=Object.keys(demoSignals).length ? demo && demoMatch(demo) : emphasizes(signalView,serviceSignal(datadog,r.source,now,datadogError)) || emphasizes(signalView,serviceSignal(datadog,r.target,now,datadogError));
   if(match){ids.add(r.source);ids.add(r.target);}
  }
  return ids;
 };
 $effect(()=>{
  const base=layout, view=signalView, enabled=focusSignals, request=manualFocus;
  untrack(()=>{
   const focusRequest = JSON.stringify([view, enabled, request]);
   const refit = lastFocusRequest !== focusRequest;
   lastFocusRequest = focusRequest;
   cancelAnimationFrame(frame);
   const ids=enabled && request?.view===view ? new Set(request.ids) : enabled ? matched() : new Set<string>();
   const next=focusLayout(base,snapshot,ids);
   focusCount=ids.size;
   targetLayout=next;
   const previous=displayLayout;
   if(!previous){displayLayout=next;return;}
   // Background topology polls must not override the user's viewport.
   if (refit) revision++;
   if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){displayLayout=next;moving=false;return;}
   const interpolate=layoutTween(previous,next);const start=performance.now();moving=true;
   const animate=(time:number)=>{const t=Math.min(1,(time-start)/520);displayLayout=interpolate(1-Math.pow(1-t,3));if(t<1)frame=requestAnimationFrame(animate);else moving=false;};
   frame=requestAnimationFrame(animate);
  });
 });
 onDestroy(()=>cancelAnimationFrame(frame));
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
 let nodes: Node[] = $derived(drawn.nodes.filter(n=>snapshot.systems.some(s=>s.id===n.id)).map(n => {
  const system = snapshot.systems.find(s => s.id === n.id)!;
  const signal = serviceSignal(datadog, system.id, now, datadogError);
  return { id: n.id, type: 'system', position: { x: n.x, y: n.y }, width: n.width, height: n.height, selected: selected === n.id, ariaLabel: `${system.label}, ${snapshot.mode === 'live' && system.health === 'healthy' ? 'reachable' : system.health}. Press Enter to inspect.`, data: { system, context: n.context, width:n.width, height:n.context ? n.height : system.kind === 'Shared broker' || system.id === 'infra:rabbitmq' ? 112 : n.height, signal, participants, onselect, mqViews, onpreview, live: snapshot.mode === 'live', dimmed: selected ? !relevant.has(n.id) : !(Object.keys(demoSignals).length ? snapshot.relationships.some(r => (r.source === n.id || r.target === n.id) && demoSignals[r.id] && demoMatch(demoSignals[r.id])) || signalView === 'overview' : emphasizes(signalView, signal)) } };
 }));
 let edges: Edge[] = $derived(drawn.edges.filter(e => snapshot.relationships.some(r => r.id === e.id && r.kind !== 'event')).map(e => {
  const r = snapshot.relationships.find(r => r.id === e.id)!;
  const sourceSignal = serviceSignal(datadog, r.source, now, datadogError);
  const targetSignal = serviceSignal(datadog, r.target, now, datadogError);
  const demoSignal = demoSignals[r.id];
  const emphasized = Object.keys(demoSignals).length ? signalView === 'overview' || (demoSignal && demoMatch(demoSignal)) : emphasizes(signalView, sourceSignal) || emphasizes(signalView, targetSignal);
  const observed = !datadogError && datadog && ['connected','partial'].includes(datadog.status) && now - Date.parse(datadog.observedAt) <= datadog.freshForMs && (r.observation ? r.observation === 'observed' : datadog.dependencies.some(d => d.source === r.source && d.target === r.target));
  return { id: e.id, source: r.source, target: r.target, type: 'routed', selected: selected === e.id, ariaLabel: `${r.label}, ${r.kind}, ${r.health}. Press Enter to inspect.`, data: { relationship: r, demoSignal, demo: Object.keys(demoSignals).length > 0, points: e.points, observed: !!observed, dimmed: selected ? !relevant.has(e.id) : !emphasized } };
 }));
 let selectedIds = $derived(snapshot.systems.some(s => s.id === selected) ? [selected!] : snapshot.relationships.filter(r => r.id === selected).flatMap(r => [r.source, r.target]));
</script>
<SvelteFlow {nodes} {edges} {nodeTypes} {edgeTypes} fitView minZoom={0.15} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable deleteKey={null} onnodeclick={({ node }) => onselect(node.id)} onedgeclick={({ edge }) => onselect(edge.id)} onselectionchange={({ nodes: ns, edges: es }) => { const id = ns[0]?.id ?? es[0]?.id; if (id && id !== selected) onselect(id); }} onpaneclick={() => onselect(null)}>
 <Background />
 <GraphControls {selectedIds} {revision} targetLayout={targetLayout ?? layout} onFocusSelection={()=>manualFocus={view:signalView,ids:selectedIds}} onFullMesh={()=>manualFocus={view:signalView,ids:[]}} />
 <GraphLabels {edges} layout={drawn} {snapshot} {selected} {onselect} {moving} />
 {#if focusCount || moving}<div class="focus-context-caption" aria-live="polite">{moving ? 'Reflowing…' : `${focusCount} systems in focus · remaining mesh shown in miniature`}</div>{/if}
 <Controls showLock={false} />
 <MiniMap pannable zoomable nodeColor="var(--color-primary-light)" nodeStrokeColor="var(--color-primary)" />
</SvelteFlow>
