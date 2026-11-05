<script lang="ts">
 import type {DatadogSnapshot} from '$lib/graph/datadog';
 import {pathRates} from '$lib/graph/path-rates';
 let {data,source,target,now,failed=false}:{data:DatadogSnapshot|null;source:string;target:string;now:number;failed?:boolean}=$props();
 let rates=$derived(pathRates(data,source,target,now,failed));
</script>
<section aria-label="Path request rate" class="path-rate">
 {#if rates.value != null}<strong>{rates.value.toLocaleString(undefined,{maximumFractionDigits:2})} req/s measured</strong><p>Application counter · completed HTTP attempts at measured endpoints, including failures. Other endpoints may be uninstrumented.{rates.state==='partial'?' Partial endpoint coverage.':''}</p><p>{new Date(rates.window!.from).toLocaleTimeString()}–{new Date(rates.window!.to).toLocaleTimeString()} · {(rates.window!.to-rates.window!.from)/1000}s bucket</p><p>{data!.scope.environment} / {data!.scope.deployment}{data!.scope.machine?` / ${data!.scope.machine}`:''} · updated {new Date(data!.pathRateObservedAt!).toLocaleTimeString()} · expires after {data!.pathRateFreshForMs!/1000}s</p>
 {:else}<p>Request rate {rates.state==='stale'?'stale':'unavailable'} for this path. Retained span counts are not requests/sec.</p>{/if}
</section>
<style>.path-rate {margin-block:12px;padding:10px;border:1px solid var(--color-border);border-radius:4px}strong{font-size:var(--vishnu-ui-font-size)}p{font-size:var(--vishnu-ui-font-size);line-height:1.5;margin:5px 0}</style>
