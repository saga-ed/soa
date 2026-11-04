<script lang="ts">
 import { untrack } from 'svelte';
 import type { MeshLayout } from '$lib/graph/types';

 import { Panel, useSvelteFlow } from '@xyflow/svelte';
 let { selectedIds, revision=0, targetLayout, onFocusSelection, onFullMesh }: { selectedIds: string[]; revision?:number; targetLayout:MeshLayout; onFocusSelection:()=>void; onFullMesh:()=>void } = $props();
 const { fitView, fitBounds } = useSvelteFlow();
 $effect(() => {
  if (!revision) return;
  const target = untrack(() => targetLayout);
  // Let the flow's ResizeObserver commit the canvas size before fitting it.
  let frame = requestAnimationFrame(() => {
   frame = requestAnimationFrame(() => {
    void fitBounds({x:0,y:0,width:target.width,height:target.height},{padding:.1,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:520});
   });
  });
  return () => cancelAnimationFrame(frame);
 });

</script>
<Panel position="top-left"><div class="graph-actions"><button onclick={onFullMesh}>Fit mesh</button><button disabled={!selectedIds.length} onclick={() => fitView({ nodes: selectedIds.map(id => ({ id })), padding: 0.4, maxZoom: 1.2 })}>Fit selection</button><button disabled={!selectedIds.length} onclick={onFocusSelection}>Focus selection</button></div></Panel>
