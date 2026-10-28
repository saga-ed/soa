<script lang="ts">
 import { onMount, untrack } from 'svelte';
 import type { MeshLayout } from '$lib/graph/types';

 import { Panel, useSvelteFlow } from '@xyflow/svelte';
 let { selectedIds, revision=0, targetLayout, onFocusSelection, onFullMesh }: { selectedIds: string[]; revision?:number; targetLayout:MeshLayout; onFocusSelection:()=>void; onFullMesh:()=>void } = $props();
 const { fitView, fitBounds } = useSvelteFlow();
 let controls: HTMLDivElement;
 $effect(()=>{const current=revision;if(current)untrack(()=>{const target=targetLayout;void fitBounds({x:0,y:0,width:target.width,height:target.height},{padding:.1,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:520});});});
 onMount(() => {
  const canvas = controls.closest('.svelte-flow');
  if (!canvas) return;
  let previousWidth: number | undefined;
  let previousHeight: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const observer = new ResizeObserver(([entry]) => {
   const { width, height } = entry.contentRect;
   if (previousWidth === undefined) {
    previousWidth = width;
    previousHeight = height;
    return;
   }
   if (width <= 0 || height <= 0 || (width === previousWidth && height === previousHeight)) return;
   previousWidth = width;
   previousHeight = height;
   clearTimeout(timer);
   // Wait for fullscreen transitions and the flow's own size observer to settle.
   timer = setTimeout(() => { void fitView({ padding: 0.18 }); }, 150);
  });
  observer.observe(canvas);
  return () => { observer.disconnect(); clearTimeout(timer); };
 });
</script>
<Panel position="top-left"><div class="graph-actions" bind:this={controls}><button onclick={() => {onFullMesh();void fitView({ padding: 0.18 });}}>Fit mesh</button><button disabled={!selectedIds.length} onclick={() => fitView({ nodes: selectedIds.map(id => ({ id })), padding: 0.4, maxZoom: 1.2 })}>Fit selection</button><button disabled={!selectedIds.length} onclick={onFocusSelection}>Focus selection</button></div></Panel>
