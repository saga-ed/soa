<script lang="ts">
 import { onMount } from 'svelte';
 import type { ChartSpec, ChartResult } from '$lib/graph/charts';
 import type { EChartsType, EChartsCoreOption } from 'echarts/core';
 let { spec, refresh = 0 }: { spec: ChartSpec; refresh?: number } = $props();
 let container: HTMLDivElement;
 let chart: EChartsType | undefined;
 let data = $state<ChartResult | null>(null), error = $state(''), loading = $state(false);
 let mounted = $state(false), ready = $state(false);
 onMount(() => {
  let disposed = false;
  const observer = new ResizeObserver(() => chart?.resize());
  observer.observe(container);
  void import('$lib/graph/chart-renderer').then(core => {
   if (disposed) return;
   chart = core.init(container, undefined, { renderer: 'svg' }); ready = true;
  });
  mounted = true;
  return () => { disposed = true; observer.disconnect(); chart?.dispose(); };
 });
 $effect(() => {
  const input = JSON.stringify(spec); refresh;
  if (!mounted) return;
  const controller = new AbortController();
  loading = true; error = ''; data = null;
  void fetch('/api/charts/query', {method:'POST',headers:{'Content-Type':'application/json'},body:input,signal:controller.signal})
   .then(async response => { const result=await response.json(); if(!response.ok)throw new Error(result.error ?? 'History unavailable.'); return result as ChartResult; })
   .then(result => {if(!controller.signal.aborted)data=result;})
   .catch(e => {if(!controller.signal.aborted)error=e.message;})
   .finally(()=>{if(!controller.signal.aborted)loading=false;});
  return () => controller.abort();
 });
 $effect(() => {
  if (!ready || !chart) return;
  if (!data || data.status !== 'ready') { chart.clear(); return; }
  const fontSize = parseFloat(getComputedStyle(container).fontSize);
  const common = { animation:false, textStyle:{fontSize,color:'#bac9d7'}, backgroundColor:'transparent',
   grid:{left:70,right:65,top:60,bottom:65}, legend:{type:'scroll',top:0,textStyle:{fontSize,color:'#bac9d7'}},
   tooltip:{trigger:'axis',renderMode:'richText',textStyle:{fontSize}}, dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:10}],
   color:['#65d6c6','#f8bd6b','#8da9ff','#ef96c2','#9ed57d'],
  };
  const axis = {axisLabel:{fontSize,color:'#aebbc8'},nameTextStyle:{fontSize,color:'#aebbc8'},splitLine:{lineStyle:{color:'#273542'}},nameLocation:'middle',nameGap:45};
  let option: EChartsCoreOption;
  if (spec.kind === 'scatter') {
   const instances=[...new Set(data.pairs?.map(p=>p.instance))];
   option={...common,tooltip:{trigger:'item',renderMode:'richText'},xAxis:{...axis,type:'value',name:'CPU (cores)'},yAxis:{...axis,type:'value',name:'Memory (MiB)'},series:instances.map(instance=>({name:instance,type:'scatter',symbolSize:6,data:data!.pairs?.filter(p=>p.instance===instance).map(p=>[p.cpu,p.memory,new Date(p.time).toISOString()])}))};
  } else if (spec.kind === 'histogram') {
   // Each distribution keeps its own bin edges. Numeric bars avoid pretending independently binned series share categories.
   const bins=data.bins??[];
   option={...common,xAxis:{...axis,type:'value',nameGap:28,name:`Value (${bins[0]?.unit ?? ''})`},yAxis:{...axis,type:'value',name:spec.population==='observations' && spec.metric==='latency'?'Retained spans':'Interval buckets',minInterval:1},series:bins.map(s=>({name:s.name,type:'bar',data:s.buckets.map(b=>({value:[(b.from+b.to)/2,b.count],name:`${b.from.toPrecision(4)}–${b.to.toPrecision(4)} ${s.unit}`}))}))};
  } else {
   const units=[...new Set(data.series.map(s=>s.unit))];
   option={...common,xAxis:{...axis,type:'time',nameGap:28,name:'Time'},yAxis:units.map((unit,i)=>({...axis,type:'value',name:unit,position:i===0?'left':'right'})),series:data.series.map(s=>({name:s.name,type:'line',yAxisIndex:units.indexOf(s.unit),showSymbol:false,connectNulls:false,data:s.points}))};
  }
  chart.setOption(option,true); chart.resize();
 });
</script>
{#if loading}<p role="status">Loading Datadog history…</p>{/if}
{#if error}<p role="alert">{error}</p>{/if}
{#if data}
 <p class="provenance"><strong>{data.status}</strong> · Datadog · {data.scope.environment} / {data.scope.deployment}{data.scope.machine ? ` / ${data.scope.machine}` : ''}<br/>{new Date(data.window.from).toLocaleString()} – {new Date(data.window.to).toLocaleString()} · {data.intervalSeconds}s intervals<br/>Queried {new Date(data.observedAt).toLocaleTimeString()} · cached for up to 3 minutes</p>
 <p>{data.message}</p>
{/if}
<div class="historical-plot" class:empty={!data || data.status !== 'ready'} bind:this={container} role="img" aria-label={`${spec.title}: ${spec.kind} chart`}></div>
{#if data?.status === 'ready'}
 <details><summary>Accessible chart data</summary><div class="data-table"><table><thead><tr><th>Series / instance</th><th>Time / interval</th><th>Value</th></tr></thead><tbody>
 {#if spec.kind === 'scatter'}{#each data.pairs ?? [] as p}<tr><td>{p.instance}</td><td>{new Date(p.time).toISOString()}</td><td>{p.cpu.toPrecision(4)} cores / {p.memory.toPrecision(4)} MiB</td></tr>{/each}
 {:else if spec.kind === 'histogram'}{#each data.bins ?? [] as s}{#each s.buckets as b}<tr><td>{s.name}</td><td>{b.from.toPrecision(4)} – {b.to.toPrecision(4)} {s.unit}</td><td>{b.count}</td></tr>{/each}{/each}
 {:else}{#each data.series as s}{#each s.points as p}<tr><td>{s.name}</td><td>{new Date(p[0]).toISOString()}</td><td>{p[1] === null ? 'Unknown' : `${p[1].toPrecision(4)} ${s.unit}`}</td></tr>{/each}{/each}{/if}
 </tbody></table></div></details>
{/if}
{#if data?.link}<a href={data.link} target="_blank" rel="noreferrer">Open scoped traces in Datadog ↗</a>{/if}
<style>
 .historical-plot { height:300px; width:100%; font-size:var(--vishnu-ui-font-size); }
 .historical-plot.empty { height:0; overflow:hidden; }
 p { margin:.5rem 0; color:#aebbc8; line-height:1.5; } strong {color:#65d6c6;text-transform:uppercase;} a {color:#8fc9fa;}
 .data-table {max-height:220px;overflow:auto;} table {border-collapse:collapse;width:100%;} td,th {padding:.35rem;text-align:left;border-bottom:1px solid #34424e;}
</style>
