<script lang="ts">
 import '@fontsource-variable/montserrat';
 import '@saga-ed/product-style/css/tokens.css';
 import '@saga-ed/product-style/css/base.css';
 import '@saga-ed/product-style/css/components.css';
 import '@xyflow/svelte/dist/style.css';
 import '$lib/app.css';
 let { children } = $props();
</script>
{@render children()}
