<script lang="ts">
 import { resourceRows, resourcePressure, type ResourceSnapshot, type ResourceSort } from '$lib/graph/assistant';
 import type { MeshSnapshot } from '$lib/graph/types';
 let { data, mesh, system = $bindable(''), sort = $bindable<ResourceSort>('cpu'), onselect, now }: { data: ResourceSnapshot | null; mesh: MeshSnapshot; system: string; sort: ResourceSort; onselect: (id: string) => void; now: number } = $props();
 let rows = $derived(resourceRows(data, system, sort, now).filter(r => mesh.systems.some(s => s.id === r.system)));
 const percent = (value: number | null) => value == null ? '—' : `${value.toFixed(1)}%`;
 const memory = (value: number | null) => value == null ? '—' : `${(value / 2 ** 20).toFixed(0)} MiB`;
</script>
<section class="resources-panel" aria-label="System resources">
 <div class="resource-toolbar"><h2>System resources</h2><label>System <select bind:value={system}><option value="">All systems</option>{#each mesh.systems as s}<option value={s.id}>{s.label}</option>{/each}</select></label><label>Worst first <select bind:value={sort}><option value="cpu">CPU pressure</option><option value="memory">Memory pressure</option></select></label></div>
 <p>{data?.message ?? 'Loading resource measurements…'}</p>
 {#if data}<p class="resource-scope">{data.scope.environment} / {data.scope.deployment} · five-minute averages · {new Date(data.observedAt).toLocaleTimeString()} · {data.status}</p>{/if}
 <div class="resource-scroll"><table><thead><tr><th>System / instance</th><th>Deployment (task family)</th><th>CPU cores</th><th>CPU / limit</th><th>Working set</th><th>Memory limit</th><th>Memory / limit</th></tr></thead><tbody>{#each rows as row}<tr class:pressure={resourcePressure(row) >= 80}><td><button onclick={() => onselect(row.system)}>{row.system}</button><small>{row.instance.slice(0,12)}</small></td><td>{row.deployment}</td><td>{row.cpuCores?.toFixed(3) ?? '—'}</td><td>{percent(row.cpuPercent)}</td><td>{memory(row.memoryBytes)}</td><td>{memory(row.memoryLimitBytes)}</td><td>{percent(row.memoryPercent)}</td></tr>{:else}<tr><td colspan="7">No fresh resource measurements for this selection. Missing data does not mean healthy or zero usage.</td></tr>{/each}</tbody></table></div>
 <small>Amber marks a five-minute CPU or memory average at or above 80% of a reported container limit. Each replica remains separate. Request latency and resource pressure may correlate without proving a cause.</small>
</section>
<style>
 .resources-panel {padding:1rem;border:1px solid var(--color-border,#bac6d0);border-radius:.75rem;margin:.75rem 0;background:var(--color-bg-surface,white);} .resource-toolbar{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;} h2{margin:0;} table{width:100%;border-collapse:collapse;font-size:var(--vishnu-ui-font-size);} th,td{text-align:left;padding:.6rem;border-bottom:1px solid #d5dce2;} th{white-space:nowrap;} .resource-scroll{overflow:auto;max-height:24rem;} small{display:block;margin:.5rem 0;} .pressure{background:#fff0c2;color:#3d310f;} .resource-scope{font-size:var(--vishnu-ui-font-size);}
</style>
