<script lang="ts">
 import FanoutIcon from './FanoutIcon.svelte';
 import { onMount } from 'svelte';
 import { useStore, type Edge } from '@xyflow/svelte';
 import { placeLabels, type Box } from '$lib/graph/label-placement';
 import { signalColor, signalDegree, signalNames, type DemoSignal } from '$lib/fixtures/signals';
 import { connectionLabel } from '$lib/graph/presentation';
 import type { MeshLayout, MeshSnapshot, Relationship } from '$lib/graph/types';
 let { edges, layout, snapshot, selected, onselect, moving = false }: { edges:Edge[]; layout:MeshLayout; snapshot:MeshSnapshot; selected:string|null; onselect:(id:string)=>void; moving?:boolean } = $props();
 const store = useStore();
 let layer:HTMLDivElement;
 let bounds = $state({width:0,height:0});
 let reserved = $state<Box[]>([]);
 let measure = $state.raw<CanvasRenderingContext2D|null>(null);
 let fontVersion = $state(0);
 let hover = $state<{text:string;x:number;y:number;id:string}|null>(null);
 let crowdedOpen = $state(false);
 let closeTimer:ReturnType<typeof setTimeout>;
 const close = () => {clearTimeout(closeTimer);closeTimer=setTimeout(()=>hover=null,120);};
 const reveal = (id:string,text:string,element:HTMLElement) => {
  clearTimeout(closeTimer);const r=element.getBoundingClientRect();
  hover={id,text,x:Math.max(12,Math.min(r.left,window.innerWidth-332)),y:r.bottom+190<window.innerHeight?r.bottom+8:Math.max(12,r.top-190)};
 };
 onMount(()=>{
  measure=document.createElement('canvas').getContext('2d');
  let active=true;void document.fonts.ready.then(()=>{if(active)fontVersion++;});
  const update=()=>{const root=layer.parentElement!;const r=root.getBoundingClientRect();bounds={width:r.width,height:r.height};reserved=[...root.querySelectorAll('.graph-actions,.svelte-flow__controls,.svelte-flow__minimap,.svelte-flow__attribution,.focus-context-caption')].map(el=>{const b=el.getBoundingClientRect();return {x:b.left-r.left,y:b.top-r.top,width:b.width,height:b.height};});};
  const observer=new ResizeObserver(update);observer.observe(layer.parentElement!);update();
  return ()=>{active=false;observer.disconnect();clearTimeout(closeTimer);};
 });
 let items = $derived(edges.map(edge=>{
  const r=edge.data!.relationship as Relationship;const signal=edge.data!.demoSignal as DemoSignal|undefined;
  const text=signal?`${signalDegree(signal)>=.7?'▲ ':''}${signalNames[signal.kind]} · ${signal.value} ${signal.unit} · ${Math.round(signalDegree(signal)*100)}%`: `${connectionLabel(r)}${r.declared ? ' · declared' : ''}${edge.data!.observed?' · observed':''}${selected===r.id?` · ${r.label}`:''}`;
  const title=`${snapshot.systems.find(s=>s.id===r.source)?.label} → ${snapshot.systems.find(s=>s.id===r.target)?.label}\n${text}\n${r.summary}`;
  return {id:r.id,kind:signal?.kind,protocol:connectionLabel(r),text,title,points:layout.edges.find(e=>e.id===r.id)?.points??[],color:signal?signalColor(signal):r.health==='critical'?'var(--color-signal-error)':r.health==='warning'?'var(--color-attention)':'var(--color-text-secondary)',icon:signal?{hot:'↗',slow:'◷',fanout:'⑂',error:'!'}[signal.kind]:'i',signal:!!signal,dimmed:!!edge.data!.dimmed,priority:selected===r.id?100:signal?50:['http','dependency'].includes(r.kind)?20:0};
 }));
 let placements = $derived.by(()=>{
  fontVersion;
  if(measure)measure.font='600 12px "Montserrat Variable", sans-serif';
  const v=store.viewport;
  const obstacles=layout.nodes.map(n=>({x:n.x*v.zoom+v.x,y:n.y*v.zoom+v.y,width:n.width*v.zoom,height:n.height*v.zoom+(!n.context?20:0)}));
  return placeLabels(items.map(item=>({id:item.id,priority:item.priority,compact:item.dimmed||moving,width:(measure?.measureText(item.text).width??item.text.length*8)+24+(item.kind==='fanout'?22:0),shortWidth:(measure?.measureText(item.protocol).width??item.protocol.length*8)+24+(item.kind==='fanout'?22:0),points:item.points.map(p=>({x:p.x*v.zoom+v.x,y:p.y*v.zoom+v.y}))})),[...obstacles,...reserved],{x:0,y:0,...bounds},v.zoom);
 });
 $effect(()=>{store.viewport; moving; hover=null; crowdedOpen=false;});
</script>
<div class="graph-label-layer" data-layout-moving={moving} bind:this={layer}>
 {#each placements.placed as placed (placed.id)}
  {@const item=items.find(i=>i.id===placed.id)!}
  <button class="path-label nodrag nopan" class:compact={placed.compact} class:protocol-only={!placed.compact && (placed.short || !item.signal)} class:quiet-marker={placed.compact && !item.signal} class:context-label={item.dimmed} class:selected-label={selected===item.id} data-path-label={item.id} data-compact={placed.compact} style:left={`${placed.x}px`} style:top={`${placed.y}px`} style:width={`${placed.width}px`} style:height={`${placed.height}px`} style:color={item.color} aria-label={`Inspect ${item.title}`} aria-describedby={hover?.id===item.id?'path-hover-detail':undefined} onclick={event=>{event.stopPropagation();onselect(item.id);}} onmouseenter={event=>reveal(item.id,item.title,event.currentTarget)} onmouseleave={close} onfocus={event=>reveal(item.id,item.title,event.currentTarget)} onblur={close} onkeydown={event=>{if(event.key==='Escape'){event.stopPropagation();hover=null;}}}>{#if placed.compact}{#if item.kind==='fanout'}<FanoutIcon />{:else}i{/if}{:else}{#if item.kind==='fanout'}<FanoutIcon />{/if}<span>{placed.short?item.protocol:item.text}</span><span class="inline-path-info" aria-hidden="true">i</span>{/if}</button>
 {/each}
 {#if placements.crowded.length}
  <div class="crowded-paths nodrag nopan"><button aria-expanded={crowdedOpen} onclick={()=>crowdedOpen=!crowdedOpen}>{placements.crowded.length} crowded paths · details</button>{#if crowdedOpen}<div class="crowded-path-list">{#each placements.crowded as id}{@const item=items.find(i=>i.id===id)!}<button onclick={()=>{onselect(id);crowdedOpen=false;}}>{item.title}</button>{/each}</div>{/if}</div>
 {/if}
</div>
{#if hover}<div id="path-hover-detail" role="tooltip" class="path-tooltip" style:left={`${hover.x}px`} style:top={`${hover.y}px`} onmouseenter={()=>clearTimeout(closeTimer)} onmouseleave={close}>{hover.text}</div>{/if}
