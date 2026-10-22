<script lang="ts">
 import { onMount } from 'svelte';
 import { Panel, useSvelteFlow } from '@xyflow/svelte';
 let { selectedIds }: { selectedIds: string[] } = $props();
 const { fitView } = useSvelteFlow();
 let controls: HTMLDivElement;
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
<Panel position="top-left"><div class="graph-actions" bind:this={controls}><button onclick={() => fitView({ padding: 0.18 })}>Fit mesh</button><button disabled={!selectedIds.length} onclick={() => fitView({ nodes: selectedIds.map(id => ({ id })), padding: 0.4, maxZoom: 1.2 })}>Fit selection</button></div></Panel>
