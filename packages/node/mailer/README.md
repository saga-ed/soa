# @saga-ed/soa-mailer

Shared transactional-email primitive for the Saga fleet. A thin, template-free
`MailService` over a pluggable `MailAdapter`:

- **`StubMailAdapter`** — logs the payload (dev/test). The default-safe provider.
- **`SesMailAdapter`** — AWS SES, optionally via an STS assume-role hop (prod).

The service owns no email bodies — each consuming service composes its own
`MailMessage` (verification codes, password resets, sync digests, …) and calls
`send`.

## Usage

```ts
import {
  MailService,
  StubMailAdapter,
  SesMailAdapter,
  loadMailConfig,
} from '@saga-ed/soa-mailer';

const config = loadMailConfig(); // reads MAIL_PROVIDER / MAIL_FROM_ADDRESS / MAIL_SES_*
const adapter =
  config.mailProvider === 'ses'
    ? new SesMailAdapter(config, logger)
    : new StubMailAdapter(logger);

const mail = new MailService(adapter);
await mail.send({ to: 'admin@district.org', subject: 'Roster sync', html: '<p>…</p>' });
```

Plain constructor injection — wire it directly or behind your own DI container.
`logger` is any object with `info`/`error` (a `@saga-ed/soa-logger` ILogger fits).

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MAIL_PROVIDER` | `stub` | `stub` \| `ses` |
| `MAIL_FROM_ADDRESS` | `noreply@sagaeducation.org` | verified SES sender |
| `MAIL_SES_REGION` | — | required when `ses` |
| `MAIL_SES_ROLE_ARN` | — | optional STS assume-role |

Service-specific knobs (frontend URLs, templates) belong to the consuming
service's own config, not here.

## Testing

`import { MockMailAdapter } from '@saga-ed/soa-mailer/mocks'` — records `sent[]`
and supports `failNext` to exercise error paths. `SesMailAdapter` accepts a
`sesClientFactory` seam to unit-test command construction without AWS.
