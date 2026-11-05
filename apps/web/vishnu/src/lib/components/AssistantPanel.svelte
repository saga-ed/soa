<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 import AssistantText from './AssistantText.svelte';
 import type { AssistantEvent, ViewAction } from '$lib/graph/assistant';
 let { contextKey, onaction, onrestore, canRestore }: { contextKey: string; onaction: (action: ViewAction, context: string) => boolean; onrestore: () => void; canRestore: boolean } = $props();
 let enabled = $state(false), model = $state(''), status = $state('Connecting…');
 let prompt = $state(''), busy = $state(false), error = $state(''), conversationId = $state<string | undefined>();
 let messages = $state<{ role: string; text: string }[]>([]);
 let evidence = $state<{ label: string; detail: string }[]>([]);
 let pending = $state<ViewAction[]>([]);
 let viewNotice = $state('');
 let usage = $state<{ inputTokens: number; outputTokens: number; toolCalls: number } | undefined>();
 let request: AbortController | undefined;
 onMount(() => { void fetch('/api/assistant/status').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(s => { enabled = s.enabled; model = s.model; status = s.message; }).catch(() => { status = 'Assistant unavailable on this deployment.'; }); });
 onDestroy(() => request?.abort());
 async function send(text = prompt) {
  if (busy || !enabled || !text.trim()) return;
  const key = contextKey;
  busy = true; error = ''; pending = []; evidence = []; prompt = ''; viewNotice = ''; usage = undefined;
  messages = [...messages.slice(-18), { role: 'You', text }, { role: 'Vishnu', text: '' }];
  const index = messages.length - 1;
  request = new AbortController();
  try {
   const response = await fetch('/api/assistant/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, conversationId, contextKey: key }), signal: request.signal });
   if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'Staff sign-in expired. Sign in again.' : 'Assistant request failed. Please retry.');
   const reader = response.body.getReader(), decoder = new TextDecoder();
   let buffer = '', completed = false;
   const event = (e: AssistantEvent) => {
    if (e.type === 'text') messages[index].text += e.text;
    if (e.type === 'tool') status = `Investigating: ${e.name.replaceAll('_', ' ')}`;
    if (e.type === 'evidence') evidence = [...evidence.slice(-7), { label: e.label, detail: e.detail }];
    if (e.type === 'view') { if (!onaction(e.action, e.contextKey)) pending = [...pending, e.action]; else viewNotice = e.action.type === 'restore_view' ? 'Previous view restored.' : e.action.type === 'reset_view' ? 'View reset.' : 'Investigation view updated.'; }
    if (e.type === 'done') { conversationId = e.conversationId; model = e.model; usage = e.usage; completed = true; }
    if (e.type === 'error') { completed = true; throw new Error(e.message); }
   };
   for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) event(JSON.parse(line)); }
   }
   if (!completed) throw new Error('The response was interrupted. Retry or start a new conversation.');
  } catch (e) { error = request.signal.aborted ? 'Investigation stopped.' : e instanceof Error ? e.message : 'Investigation failed.'; request.abort(); }
  finally { busy = false; status = 'Ready to investigate this mesh.'; }
 }
</script>
<section class="assistant-panel" aria-label="Vishnu assistant">
 <div class="assistant-heading"><div><h2>Ask Vishnu</h2><small>Investigate the mesh · Amazon Bedrock</small></div><div><button disabled={!canRestore} onclick={onrestore}>Restore previous view</button><button disabled={busy} onclick={() => { messages = []; conversationId = undefined; evidence = []; error = ''; pending = []; }}>New conversation</button></div></div>
 <div class="assistant-suggestions"><button disabled={!enabled || busy} onclick={() => send('Show the slowest observed calls and explain the available evidence.')}>Find slow calls</button><button disabled={!enabled || busy} onclick={() => send('Show the highest fan-out calls. Distinguish sampled evidence from total traffic.')}>Find high fan-out</button><button disabled={!enabled || busy} onclick={() => send('Show systems with the highest CPU or memory pressure and explain any missing telemetry.')}>Check resources</button></div>
 {#if messages.length}<div class="assistant-messages" aria-live="polite">{#each messages as message}<article><strong>{message.role}</strong><p>{#if message.role === 'Vishnu'}<AssistantText text={message.text || 'Investigating…'}/>{:else}{message.text}{/if}</p></article>{/each}</div>{/if}
 {#if evidence.length}<details class="assistant-evidence"><summary>Supporting evidence ({evidence.length})</summary>{#each evidence as item}<p><strong>{item.label.replaceAll('_',' ')}</strong> · {item.detail}</p>{/each}</details>{/if}
 {#if pending.length}<div role="status">Your view changed during the investigation. <button onclick={() => { for (const action of pending) onaction(action, contextKey); pending = []; }}>Apply suggested view</button></div>{/if}
 {#if error}<p role="alert">{error}</p>{/if}
 {#if viewNotice}<p role="status">{viewNotice}</p>{/if}
 <form onsubmit={event => { event.preventDefault(); void send(); }}><label for="assistant-prompt">What would you like to investigate?</label><div class="assistant-input"><textarea id="assistant-prompt" bind:value={prompt} maxlength={4000} rows="2" placeholder="Show slow calls into IAM and check resource pressure…" disabled={!enabled}></textarea>{#if busy}<button type="button" onclick={() => request?.abort()}>Stop</button>{:else}<button type="submit" disabled={!enabled || !prompt.trim()}>Investigate</button>{/if}</div></form>
 <small role="status">{status}{#if enabled} · {model}{/if}</small>
 {#if usage}<small>{usage.toolCalls} tool calls · {usage.inputTokens.toLocaleString()} input / {usage.outputTokens.toLocaleString()} output tokens</small>{/if}
</section>
<style>
 .assistant-panel { padding: 16px; margin: 0; font-size:var(--vishnu-ui-font-size); line-height: 1.5; border: 1px solid var(--color-border, #bac6d0); border-radius: 12px; background: var(--color-bg-surface, white); }
 .assistant-heading { display: flex; flex-direction: column; gap: 12px; }
 .assistant-heading>div:last-child, .assistant-input { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
 h2 { margin: 0; font-size:var(--vishnu-ui-font-size); line-height: 1.5; font-weight: 600; }
 p, label, button, textarea, small, summary { font-family: inherit; font-size: inherit; line-height: inherit; }
 .assistant-suggestions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 16px 0; }
 .assistant-suggestions button { padding: 8px 6px; }
 .assistant-messages { max-height: 45vh; overflow: auto; overflow-wrap: anywhere; }
 article { padding: 12px 0; border-bottom: 1px solid var(--color-border, #bac6d0); }
 article:first-child { padding-top: 0; }
 article p { white-space: pre-wrap; margin: 6px 0 0; }
 .assistant-input { align-items: stretch; }
 .assistant-input textarea { flex: 1; min-width: 0; width: 100%; min-height: 72px; padding: 10px; resize: vertical; }
 form label { display: block; margin: 16px 0 8px; font-weight: 600; }
 .assistant-evidence { margin: 12px 0; overflow-wrap: anywhere; }
 .assistant-evidence p { margin: 8px 0; }
 [role=alert] { color: #a4262c; }
 button { padding: 7px 10px; }
 small { display: block; margin-top: 8px; color: var(--color-text-muted, #64748b); overflow-wrap: anywhere; }
 @media (max-width: 480px) {
  .assistant-panel { padding: 12px; }
  .assistant-suggestions { grid-template-columns: 1fr; }
 }
</style>
