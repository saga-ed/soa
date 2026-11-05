<script lang="ts">
 import { onMount, tick } from 'svelte';
 import { normalizeTopN, TOP_N_STORAGE_KEY } from '$lib/graph/offenders';
 let { topN = $bindable(5) }: { topN?: number } = $props();
 let open = $state(false);
 let ready = $state(false);
 let wrapper: HTMLDivElement;
 let trigger: HTMLButtonElement;
 let input = $state<HTMLInputElement>();
 onMount(() => {
  try { topN = normalizeTopN(localStorage.getItem(TOP_N_STORAGE_KEY)); } catch { topN = 5; }
  ready = true;
 });
 $effect(() => { if (ready) { try { localStorage.setItem(TOP_N_STORAGE_KEY, String(topN)); } catch { /* Settings still work when storage is unavailable. */ } } });
 async function toggle() { open = !open; if (open) { await tick(); input?.focus(); input?.select(); } }
 function close() { open = false; trigger?.focus(); }
 function keydown(event: KeyboardEvent) { if (open && event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(); } }
</script>
<svelte:window onpointerdown={event => { if (open && !wrapper?.contains(event.target as Node)) open = false; }} />
<!-- The wrapper receives bubbled keyboard events from its interactive children. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="display-settings" bind:this={wrapper} onkeydown={keydown}>
 <button class="gear" bind:this={trigger} aria-label="Display settings" aria-expanded={open} aria-controls="display-settings-panel" onclick={toggle}>⚙</button>
 {#if open}
  <div id="display-settings-panel" role="dialog" tabindex="-1" aria-label="Display settings" class="settings-panel">
   <div class="settings-heading"><strong>Display settings</strong><button aria-label="Close display settings" onclick={close}>×</button></div>
   <label for="endpoint-limit">Top endpoints</label>
   <input id="endpoint-limit" bind:this={input} type="number" min="1" max="50" step="1" value={topN} oninput={event => { if (event.currentTarget.value !== '') topN = normalizeTopN(event.currentTarget.value); }} onblur={event => { event.currentTarget.value = String(topN); }} />
   <p>Show 1–50 ranked endpoints when inspecting a Slow, Hot or Fan-out path. Saved on this browser.</p>
  </div>
 {/if}
</div>
<style>
 .display-settings { position: relative; margin-left: auto; }
 .gear { width: 32px; height: 32px; padding: 0; font-size:var(--vishnu-ui-font-size); }
 .settings-panel { position: absolute; top: 38px; right: 0; z-index: 100; width: 260px; padding: 14px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: var(--color-bg); color: var(--color-text); box-shadow: 0 8px 30px #0002; }
 .settings-heading { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
 .settings-heading button { padding: 2px 8px; }
 label { display:block; font-size:var(--vishnu-ui-font-size); margin-bottom:6px; }
 input { width: 80px; }
 p { font-size:var(--vishnu-ui-font-size); line-height:1.5; color:var(--color-text-muted); margin-bottom:0; }
</style>
