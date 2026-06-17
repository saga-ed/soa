# @saga-ed/soa-inspect

Standard introspection surface for the sandbox visibility console
([microservices#662](https://github.com/hipponot/microservices/issues/662)).
A service mounts one router and declares its browsable entities; the console
discovers everything else from the manifest at runtime — so whatever build is
actually deployed in a sandbox describes itself (no version skew between the
console and mixed-variant compositions).

## Surface

| Route | Gate | Returns |
|---|---|---|
| `GET /inspect/manifest` | bearer only | service self-description: entities + fields + PII flags, event streams, gate states |
| `GET /inspect/entities/:name?limit&offset&search` | `ALLOW_INSPECT_ENTITIES` | `{ rows, total, limit, offset }` |
| `GET /inspect/entities/:name/:id` | `ALLOW_INSPECT_ENTITIES` | `{ row }` |
| `GET /inspect/status` | `ALLOW_INSPECT_STATUS` | publisher/consumer watermarks for projection-drift checks |

Gate semantics (iam-api admin-gate house pattern): `INSPECT_TOKEN` unset →
**every** route 404s; bad bearer → 401; per-surface gate off → 404.
Day-one posture is sandbox + dev only (see #662 auth decision).

## Usage

```ts
import {
  canonicalConsumerStatus, canonicalOutboxStatus,
  createInspectRouter, defineEntity, loadInspectEnv,
} from '@saga-ed/soa-inspect';

const inspectEnv = loadInspectEnv();
const sql = (q: string) => pool.query(q).then((r) => r.rows);

app.use('/inspect', createInspectRouter({
  service: 'things-api',
  token: inspectEnv.token,
  gates: inspectEnv.gates,
  entities: [
    defineEntity({
      name: 'things',
      schema: ThingRowSchema,            // z.object — introspected for the manifest
      pii: ['ownerEmail'],               // console masks these by default
      searchFields: ['name'],
      list: async ({ limit, offset, search }) => { /* prisma/pg query */ },
      get: async (id) => { /* findUnique */ },
    }),
  ],
  events: { exchange: THINGS_EXCHANGE, published: Object.keys(thingsEvents), consumerNames: ['things.iam-projection'] },
  status: {
    outbox: canonicalOutboxStatus(sql),      // services on outbox_event
    consumers: canonicalConsumerStatus(sql), // services on consumed_events
  },
}));
```

Mount **before** any human-session perimeter (Janus etc.) — the console
authenticates with the inspect bearer, not a user session.

Services with non-canonical outbox shapes (e.g. iam-api's poll-model
`event_outbox`) supply their own `status.outbox` callback; the wire shape
(`OutboxStatusSchema`) is what's fixed, not the table.

## Env

```
INSPECT_TOKEN=...              # static bearer; unset ⇒ surface is dark
ALLOW_INSPECT_ENTITIES=true    # PII-bearing entity browsing
ALLOW_INSPECT_STATUS=true      # projection watermarks (metadata only)
```

The console-side contract (response Zod schemas) is exported from this
package — the console validates every service response against
`InspectManifestSchema` / `EntityListResponseSchema` / `InspectStatusResponseSchema`.
