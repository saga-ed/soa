# @saga-ed/soa-env

One module reads environment identity (account, lane, profile) and returns declared, fail-closed
capabilities. Call sites read capabilities; they never branch on env names. Design:
[DESIGN.md](./DESIGN.md) (soa#515).

The core has zero runtime dependencies. `process.env` is read only inside `loadEnv`.

## `@saga-ed/soa-env`

```ts
import { loadEnv, type CapabilityDeclaration } from '@saga-ed/soa-env';
import { createStsAccountResolver } from '@saga-ed/soa-env/aws';

const decl: CapabilityDeclaration = {
  service: 'iam-api',
  outbound: ['clever', 'lake-export'],
  keys: { credentialSource: 'DB_CREDENTIAL_SOURCE' /* one config key per capability */ },
};

const env = await loadEnv(decl, configSource, { resolver: createStsAccountResolver() });
// env.credentialSource, env.tls, env.failFast, env.mailSink, env.outbound['clever'], ...
```

- `parseLane(vars)`: strict `LANE` parse (trim, lowercase; unset/empty = `none`); never throws.
- `resolveAccount(vars, resolver?, { fetch?, timeoutMs? })`: ECS task metadata (`TaskARN`, 2s timeout), then the
  injected resolver. Only the prod (`531314149529`) and dev (`396913734878`) accounts map; anything else
  throws. `SAGA_LOCAL=1` yields `local` and is refused when an ECS/Lambda signal is present or the
  resolver returns prod.
- `parseIdentity(vars, account)`: selects the invariant row from account x lane. Conflicts throw
  `EnvIdentityError` (`EXEC_ENV=mirror` says "set LANE=mirror").
- `createEnv(decl, identity, config)`: pure. Reads each capability through `decl.keys`, checks the
  invariant table, throws one `EnvInvariantError` listing every violation by name (never by value).
  Returns frozen capabilities.
- `loadEnv(decl, config, { resolver?, vars?, fetch?, timeoutMs? })`: boot entry.

Config value encodings: booleans `true|false`; `tls` `off|required|required:<caBundlePath>`;
`corsOrigins` comma-separated (`/re/` entries are RegExp); `outbound` `name=live|sink|off,...`.
`mailSink` is optional in a declaration; omit its key for a service with no mail.

## `@saga-ed/soa-env/testing`

```ts
import { testEnv } from '@saga-ed/soa-env/testing';
const env = testEnv({ credentialSource: 'iam-token' }); // R4-local capabilities, dev bindings
```

## `@saga-ed/soa-env/aws`

`createStsAccountResolver({ region? })` returns an `AccountResolver` backed by STS `GetCallerIdentity`.
Needs the optional peer `@aws-sdk/client-sts`.

## `@saga-ed/soa-env/eslint`

ESLint `^8.57` (flat config). Rule `@saga-ed/soa-env/no-env-identity` reports member reads (including
destructuring and computed string keys) of `EXEC_ENV`, `NODE_ENV`, `SAGA_ENV`, `LANE`, `DD_ENV`, and
comparisons of env-derived values against `prod|production|mirror|twin|staging`.

```js
import { configs } from '@saga-ed/soa-env/eslint';
export default [configs.recommended];
```

Options: `allow` (globs where reads are legal; default the env module) and `exempt`
(`[{ glob, reason }]`, reason required). Inline disables cannot be forced to carry a description by this
rule under ESLint 8; add `eslint-plugin-eslint-comments` `require-description` for that.

### `soa-env-lint-ratchet`

```sh
soa-env-lint-ratchet                      # runs `eslint --format json .`, compares to soa-env-baseline.json
soa-env-lint-ratchet --input out.json     # consume existing eslint JSON (or - for stdin)
soa-env-lint-ratchet --write              # regenerate the baseline (refused when CI is set)
```

Fails when a file's count is above baseline (new violation) or below it ("baseline stale: lower it").
New files have an implicit baseline of 0. Exit codes: 0 ok, 1 ratchet failure, 2 usage/runtime error.
