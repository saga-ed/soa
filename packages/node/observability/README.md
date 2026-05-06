# @saga-ed/soa-observability

OpenTelemetry tracing setup, Prometheus metrics for outbox/consumer, and an
Express error-classifier middleware for Saga services.

```typescript
import { initTracing } from '@saga-ed/soa-observability';
```

> **⚠️ FOOTGUN — `initTracing()` MUST run before any tracer-using import.**
>
> OpenTelemetry's tracer-provider singleton is patched in place by
> `initTracing()`. Any module loaded *before* the call captures the
> **no-op tracer** at module-load time and silently emits **zero spans**
> for its lifetime. The service still runs; you just have no traces.
>
> Both `rostering` and `program-hub` hit this. The `saga-soa/init-tracing-first`
> ESLint rule (in `@saga-ed/soa-eslint-config/base`) catches it at lint time.
>
> ### ✅ Correct
>
> ```typescript
> // main.ts
> import { initTracing } from '@saga-ed/soa-observability';
> initTracing({ serviceName: 'iam-api' });
>
> // Dynamic import AFTER tracing is initialized:
> const { startServer } = await import('./server.js');
> await startServer();
> ```
>
> ### ❌ Wrong — `reflect-metadata` precedes `initTracing()`
>
> ```typescript
> import 'reflect-metadata';            // captures no-op tracer at load
> import { container } from './ioc.js'; // same — silent dead spans
> import { initTracing } from '@saga-ed/soa-observability';
> initTracing();                         // too late
> ```
>
> ### ❌ Wrong — static import of app code before init
>
> ```typescript
> import { initTracing } from '@saga-ed/soa-observability';
> import { startServer } from './server.js';  // hoists; loads before initTracing() runs
> initTracing();
> await startServer();
> ```

## See also

- `@saga-ed/soa-eslint-config` — the `saga-soa/init-tracing-first` lint
  rule wires this into CI; runs against any file named `main.ts`.
- `claude/projects/soa_75/decisions/d-consumer-resilience.md` pattern 4 —
  decision-doc rationale.
