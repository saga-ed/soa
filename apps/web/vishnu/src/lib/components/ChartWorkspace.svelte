<script lang="ts">
 import { onMount } from 'svelte';
 import HistoricalChart from './HistoricalChart.svelte';
 import type { ChartSpec, ChartScope, ChartSet, SavedChartView } from '$lib/graph/charts';
 import type { MeshSnapshot } from '$lib/graph/types';
 let { charts, meshCollapsed, mesh, onchange, oncollapse, onload }: {charts:ChartSpec[];meshCollapsed:boolean;mesh:MeshSnapshot;onchange:(charts:ChartSpec[])=>void;oncollapse:()=>void;onload:(set:ChartSet)=>void}=$props();
 let saved=$state<SavedChartView[]>([]), selected=$state(''), name=$state(''), message=$state(''), error=$state(''), busy=$state(false);
 let scope=$state<ChartScope|null>(null), saving=$state(false), refresh=$state(0);
 let system=$state('iam-api'), metric=$state<ChartSpec['metric']>('latency'), kind=$state<ChartSpec['kind']>('line');
 const systems=$derived(mesh.systems.filter(s=>s.kind !== 'database'));
 async function api(path:string,method='GET',body?:unknown) {
  const response=await fetch(path,{method,...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error??'Chart request failed.');return result;
 }
 async function list() { saved=(await api('/api/chart-views')).views; }
 onMount(()=>{ void api('/api/charts/catalog').then(c=>{scope=c.scope;saving=c.saving;if(saving)return list();}).catch(e=>error=e.message); });
 async function save(copy=false) {
  busy=true;error='';message='';
  try {
   const current=saved.find(v=>v.id===selected);
   const value=await api(`/api/chart-views${!copy && current ? `/${current.id}`:''}`,!copy&&current?'PUT':'POST',{name,definition:{version:1,charts,meshCollapsed},...(!copy && current ? {revision:current.revision}:{})});
   selected=value.id;await list();message='Chart set pinned privately. Open it from Saved chart sets in any later session.';
  } catch(e) {error=(e as Error).message;}finally{busy=false;}
 }
 function load(id: string) { selected=id; const view=saved.find(v=>v.id===id);if(!view)return;name=view.name;onload($state.snapshot(view.definition));message='Loaded saved definition; Datadog supplies the measurements for its current time window.'; }
 async function removeSaved() {busy=true;error='';try{await api(`/api/chart-views/${selected}`,'DELETE');selected='';await list();message='Private saved view deleted. The current charts remain open.';}catch(e){error=(e as Error).message;}finally{busy=false;}}
 function add() {
  if(charts.length>=8)return;
  const resolvedMetric=kind==='scatter'?'cpu_memory':metric;
  if(kind==='histogram'&&resolvedMetric==='cpu_memory'){error='Select CPU or memory separately for a histogram.';return;}
  onchange([...charts,{id:crypto.randomUUID(),title:`${system} · ${resolvedMetric}`,system,metric:resolvedMetric,kind,statistics:resolvedMetric==='latency'?['avg','max']:['avg'],time:{mode:'rolling',minutes:30},group:'service',population:'observations'}]);
 }
 function update(id:string,patch:Partial<ChartSpec>) {onchange(charts.map(c=>c.id===id?{...c,...patch}:c));}
 function timeMode(c:ChartSpec,mode:string) {
  if(mode==='rolling')update(c.id,{time:{mode:'rolling',minutes:30}});
  else {const to=new Date(),from=new Date(to.getTime()-(c.time.mode==='rolling'?c.time.minutes:30)*60_000);update(c.id,{time:{mode:'fixed',from:from.toISOString(),to:to.toISOString()}});}
 }
 function dateChange(c:ChartSpec,field:'from'|'to',value:string) {const date=new Date(value);if(c.time.mode==='fixed'&&Number.isFinite(date.getTime()))update(c.id,{time:{...c.time,[field]:date.toISOString()}});}
 const localDate=(value:string)=>{const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);};
</script>
<section class="chart-workspace" aria-label="Historical charts">
 <header><div><strong>Historical charts</strong><span>{scope ? `${scope.environment} / ${scope.deployment}${scope.machine ? ` / ${scope.machine}`:''}` : 'Current server scope'} · private saved views</span></div><div><button onclick={()=>refresh++}>Refresh charts</button><button aria-pressed={meshCollapsed} onclick={oncollapse}>{meshCollapsed?'Expand mesh':'Minimize mesh'}</button></div></header>
 <div class="chart-controls">
  <label>Saved chart sets <select bind:value={selected} onchange={e=>load(e.currentTarget.value)}><option value="">Unsaved chart set</option>{#each saved as view}<option value={view.id}>{view.name}</option>{/each}</select></label>
  <label>Chart set name <input bind:value={name} maxlength="100" placeholder="My IAM investigation"/></label>
  <button disabled={!saving||!charts.length||!name.trim()||busy} onclick={()=>save()}>{selected?'Update pinned set':'Pin chart set'}</button>
  {#if selected}<button disabled={busy||!charts.length||!name.trim()} onclick={()=>save(true)}>Save a copy</button><button disabled={busy} onclick={removeSaved}>Delete saved set</button>{/if}
  {#if !saving}<span>Saving requires Vishnu Postgres.</span>{/if}
 </div>
 <details class="add-chart"><summary>Add a chart manually</summary><div class="chart-controls">
  <label>Chart system <select bind:value={system}>{#each systems as s}<option value={s.id}>{s.label}</option>{/each}</select></label>
  <label>Chart type <select bind:value={kind}><option value="line">Line</option><option value="histogram">Histogram</option><option value="scatter">Scatter</option></select></label>
  <label>Chart metric <select bind:value={metric} disabled={kind==='scatter'}><option value="latency">Latency</option><option value="cpu">CPU</option><option value="memory">Memory</option><option value="cpu_memory">CPU and memory</option></select></label>
  <button disabled={charts.length>=8} onclick={add}>Add chart</button>
 </div></details>
 {#if error}<p role="alert">{error}</p>{/if}{#if message}<p role="status">{message}</p>{/if}
 {#if !charts.length}<p>Ask Vishnu to plot a system’s history, or add a chart above. Line, histogram and scatter plots use the current Datadog scope.</p>{/if}
 <div class="chart-grid">{#each charts as c (c.id)}<article class="chart-card" aria-label={c.title}>
  <header><strong>{c.title}</strong><button aria-label={`Remove ${c.title}`} onclick={()=>onchange(charts.filter(v=>v.id!==c.id))}>Remove</button></header>
  <div class="chart-controls">
   <label>Time window <select value={c.time.mode} onchange={e=>timeMode(c,e.currentTarget.value)}><option value="rolling">Rolling</option><option value="fixed">Fixed dates</option></select></label>
   {#if c.time.mode==='rolling'}<label>Last <select value={c.time.minutes} onchange={e=>update(c.id,{time:{mode:'rolling',minutes:Number(e.currentTarget.value)}})}>{#each [...new Set([30,60,360,1440,10080,43200,c.time.minutes])].sort((a,b)=>a-b) as minutes}<option value={minutes}>{minutes<60?`${minutes} minutes`:minutes<1440?`${minutes/60} hours`:`${minutes/1440} days`}</option>{/each}</select></label>
   {:else}<label>From <input type="datetime-local" value={localDate(c.time.from)} onchange={e=>dateChange(c,'from',e.currentTarget.value)}/></label><label>To <input type="datetime-local" value={localDate(c.time.to)} onchange={e=>dateChange(c,'to',e.currentTarget.value)}/></label>{/if}
   {#if c.metric!=='latency'&&c.kind!=='scatter'}<label>Group <select value={c.group} onchange={e=>update(c.id,{group:e.currentTarget.value as ChartSpec['group']})}><option value="service">Mean reporting replica</option><option value="instance">Individual replicas</option></select></label>{/if}
   {#if c.kind==='histogram'&&c.metric==='latency'}<label>Histogram population <select value={c.population} onchange={e=>update(c.id,{population:e.currentTarget.value as ChartSpec['population']})}><option value="observations">Retained request durations</option><option value="rollups">Interval statistics</option></select></label>{/if}
  </div>
  <HistoricalChart spec={c} {refresh}/>
 </article>{/each}</div>
</section>
<style>
 .chart-workspace {border:1px solid #344555;border-radius:8px;background:#101c28;padding:.8rem;color:#c4d2df;font-size:var(--vishnu-ui-font-size);margin-bottom:.6rem;}
 header {display:flex;align-items:center;justify-content:space-between;gap:.6rem;} header span {display:block;color:#91a6ba;margin-top:.3rem;} header strong {color:#e0ebf4;}
 .chart-controls {display:flex;flex-wrap:wrap;gap:.5rem;align-items:end;margin:.7rem 0;} label {display:flex;flex-direction:column;gap:.25rem;}
 input,select,button {font:inherit;background:#172838;color:#d9e4ee;border:1px solid #40586d;border-radius:4px;padding:.4rem .55rem;} button {cursor:pointer;}button:disabled {opacity:.5;cursor:default;}button[aria-pressed=true] {background:#1b6159;}
 .chart-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,470px),1fr));gap:.7rem;}.chart-card {min-width:0;background:#0c1722;border:1px solid #2d4254;border-radius:6px;padding:.75rem;}
 .add-chart {margin:.7rem 0;}p {line-height:1.5;color:#aebdca;}[role=alert]{color:#ffb6aa;}
</style>
