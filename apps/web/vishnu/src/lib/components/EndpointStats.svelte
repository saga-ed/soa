<script lang="ts">
  import { currentPoint, type DatadogSnapshot } from '$lib/graph/datadog';
  import { numberLabel } from '$lib/graph/event-stats';

  let { data, source, target, now, failed = false }: {
    data: DatadogSnapshot | null;
    source: string;
    target?: string;
    now: number;
    failed?: boolean;
  } = $props();
  let fresh = $derived(!!data && !failed && ['connected', 'partial'].includes(data.status) && now - Date.parse(data.observedAt) <= data.freshForMs);
  let endpoints = $derived(fresh ? (data?.endpoints ?? []).filter(row => row.service === source) : []);
  let connections = $derived(fresh ? (data?.connections ?? []).filter(row => target ? row.source === source && row.target === target : row.source === source || row.target === source) : []);
  let retainedEndpoints = $derived(data?.endpointSource === 'retained-spans');
  const available = (status?: string) => status === 'available' || status === 'partial';
  const emptyMessage = (status?: string) => failed ? 'Refresh unavailable. Measurements are hidden until it recovers.' : data && now - Date.parse(data.observedAt) > data.freshForMs ? 'Measurements are stale.' : status === 'unconfigured' ? 'Measurements are not configured.' : 'Measurements are unavailable.';
</script>

<section class="endpoint-stats" aria-label="Endpoint and connection measurements">
  {#if !target}
    <h3>Endpoint measurements</h3>
    <p class="fixture-note">{retainedEndpoints ? 'APM resource names · retained server spans in the APM window. Counts and latency describe sampled evidence, not total traffic.' : 'APM resource names · latest metric buckets.'} — means unknown.</p>
    {#if endpoints.some(row => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(row.resource))}<p class="fixture-note">Some resources contain only an HTTP method. Their spans do not identify individual routes.</p>{/if}
    {#if fresh && available(data?.endpointStatus)}
      {#if endpoints.length}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the table.) -->
        <div class="measurement-table" tabindex="0" role="region" aria-label="Endpoint measurements table">
          <table>
            <thead><tr><th scope="col">Endpoint</th><th scope="col">{retainedEndpoints ? 'Observed spans' : 'Req/s'}</th><th scope="col">{retainedEndpoints ? 'Retained-span p95 ms' : 'p95 ms'}</th>{#if !retainedEndpoints}<th scope="col">Errors/s</th>{/if}</tr></thead>
            <tbody>{#each endpoints as row}<tr><th scope="row">{row.resource}</th><td>{retainedEndpoints ? numberLabel(row.observedSpans ?? null) : numberLabel(currentPoint(row.rate, now, data!.freshForMs), true)}</td><td>{numberLabel(currentPoint(row.p95Ms, now, data!.freshForMs))}</td>{#if !retainedEndpoints}<td>{numberLabel(currentPoint(row.errorRate, now, data!.freshForMs), true)}</td>{/if}</tr>{/each}</tbody>
          </table>
        </div>
      {:else}<p>No endpoint measurements returned for this service in this scope.</p>{/if}
      {#if data?.endpointStatus === 'partial' || data?.endpointLimited}<p class="fixture-note">Partial endpoint coverage. This is not a complete endpoint inventory.</p>{/if}
    {:else}<p>{emptyMessage(data?.endpointStatus)}</p>{/if}
  {/if}

  <h3>Caller → callee measurements</h3>
  {#if target}<p class="connection-pair"><strong>{source} → {target}</strong></p>{/if}
  <p class="fixture-note">Retained client spans attributed to their peer service within the APM window. Latency measures the outgoing call. Counts are observed spans, not total requests or calls per request.</p>
  {#if fresh && available(data?.connectionStatus)}
    {#if connections.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the table.) -->
      <div class="measurement-table" tabindex="0" role="region" aria-label="Caller callee measurements table">
        <table>
          <thead><tr><th scope="col">Caller → callee</th><th scope="col">Observed spans</th><th scope="col">Retained-span p95 ms</th></tr></thead>
          <tbody>{#each connections as row}<tr><th scope="row">{row.source} → {row.target}</th><td>{numberLabel(row.observedSpans)}</td><td>{numberLabel(row.p95Ms)}</td></tr>{/each}</tbody>
        </table>
      </div>
    {:else}<p>No attributable spans returned for {target ? 'this connection' : 'this service'} in this scope. This does not establish zero traffic.</p>{/if}
    {#if data?.connectionStatus === 'partial' || data?.connectionLimited}<p class="fixture-note">Partial connection coverage. Additional callers or callees may be absent.</p>{/if}
  {:else}<p>{emptyMessage(data?.connectionStatus)}</p>{/if}
</section>

<style>
  .endpoint-stats { border-top: 1px solid var(--color-border); margin-top: var(--space-md); padding-top: var(--space-sm); }
  .measurement-table { overflow-x: auto; max-width: 100%; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
  table { border-collapse: collapse; font-size: 11px; width: 100%; }
  th, td { padding: 8px; text-align: right; vertical-align: top; border-bottom: 1px solid var(--color-border); }
  th:first-child { text-align: left; overflow-wrap: anywhere; min-width: 110px; }
  thead th { background: var(--color-bg-secondary); }
  tbody th { font-weight: 500; }
  td { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .connection-pair { overflow-wrap: anywhere; }
</style>
