<script lang="ts">
 let { text }: { text: string } = $props();
</script>

{#snippet inline(value: string, emphasis: boolean)}
 {#each value.split(emphasis ? /(`[^`\n]+`|\*\*[^\n]+?\*\*)/g : /(`[^`\n]+`)/g) as part}
  {#if part.startsWith('`') && part.endsWith('`') && part.length > 2}
   <code>{part.slice(1, -1)}</code>
  {:else if emphasis && part.startsWith('**') && part.endsWith('**') && part.length > 4}
   <strong>{@render inline(part.slice(2, -2), false)}</strong>
  {:else}{part}{/if}
 {/each}
{/snippet}

<!-- Only inline emphasis and code are formatted; all content remains escaped text. -->
{@render inline(text, true)}

<style>
 code { font-size: inherit; line-height: inherit; padding: 1px 3px; border-radius: 3px; background: var(--color-bg-subtle, #f1f5f9); color: inherit; overflow-wrap: anywhere; }
</style>
