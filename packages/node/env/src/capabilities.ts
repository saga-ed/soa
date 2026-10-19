import { EnvInvariantError } from './errors.js';
import type {
  Capabilities,
  CapabilityDeclaration,
  ConfigSource,
  CredentialSource,
  EnvIdentity,
  MailSink,
  OutboundBinding,
  TlsCapability,
} from './types.js';

type Parsed<T> = { ok: true; value: T } | { ok: false };

const DEV_ORIGIN = /(^|[/.@])(localhost|127\.0\.0\.1|\[::1\]|wootdev\.com)([:/]|$)/i;

function oneOf<T extends string>(raw: string, allowed: readonly T[]): Parsed<T> {
  return (allowed as readonly string[]).includes(raw)
    ? { ok: true, value: raw as T }
    : { ok: false };
}

function parseBool(raw: string): Parsed<boolean> {
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false };
}

function nonEmpty(raw: string): Parsed<string> {
  return raw.trim() === '' ? { ok: false } : { ok: true, value: raw.trim() };
}

/** `off` | `required` | `required:<caBundlePath>` */
function parseTls(raw: string): Parsed<TlsCapability> {
  if (raw === 'off') return { ok: true, value: Object.freeze({ required: false }) };
  if (raw === 'required') return { ok: true, value: Object.freeze({ required: true }) };
  if (raw.startsWith('required:') && raw.length > 'required:'.length) {
    return {
      ok: true,
      value: Object.freeze({ required: true, caBundlePath: raw.slice('required:'.length) }),
    };
  }
  return { ok: false };
}

/** Comma-separated; an entry wrapped in slashes is a RegExp. */
function parseOrigins(raw: string): Parsed<readonly (string | RegExp)[]> {
  const entries = raw
    .split(',')
    .map(e => e.trim())
    .filter(e => e !== '');
  try {
    const parsed = entries.map(e =>
      e.length > 2 && e.startsWith('/') && e.endsWith('/') ? new RegExp(e.slice(1, -1)) : e
    );
    return { ok: true, value: Object.freeze(parsed) };
  } catch {
    return { ok: false };
  }
}

function parseHops(raw: string): Parsed<number> {
  return /^\d{1,3}$/.test(raw) ? { ok: true, value: Number(raw) } : { ok: false };
}

/** `name=binding,name=binding`. Returns bindings plus the names of unknown/malformed entries. */
function parseOutbound(
  raw: string,
  declared: readonly string[]
): { bindings: Record<string, OutboundBinding>; problems: string[] } {
  const bindings: Record<string, OutboundBinding> = {};
  const problems: string[] = [];
  let undeclared = false;
  for (const entry of raw
    .split(',')
    .map(e => e.trim())
    .filter(e => e !== '')) {
    const eq = entry.indexOf('=');
    const name = eq === -1 ? '' : entry.slice(0, eq).trim();
    const binding = oneOf(eq === -1 ? '' : entry.slice(eq + 1).trim(), [
      'live',
      'sink',
      'off',
    ] as const);
    if (eq === -1) {
      problems.push('outbound has a malformed entry');
    } else if (!declared.includes(name)) {
      undeclared = true;
    } else if (!binding.ok) {
      problems.push(`outbound.${name} has an invalid binding`);
    } else {
      bindings[name] = binding.value;
    }
  }
  if (undeclared) {
    problems.push(
      `outbound lists integrations not declared by the service (declared: ${declared.join(', ')})`
    );
  }
  for (const name of declared) {
    if (!(name in bindings) && !problems.some(p => p.startsWith(`outbound.${name} `))) {
      problems.push(`outbound.${name} is declared but not configured`);
    }
  }
  return { bindings, problems };
}

function hasDevOrigin(origins: readonly (string | RegExp)[]): boolean {
  return origins.some(o => DEV_ORIGIN.test(typeof o === 'string' ? o : o.source));
}

/**
 * Pure. Reads each capability through `decl.keys` from the config source, then evaluates the
 * invariant table for `identity.row`. A missing key throws; there are no silent defaults.
 * Throws one EnvInvariantError listing every violation by capability/key name, never by value.
 *
 * Value encodings: booleans `true|false`; `tls` `off|required|required:<caBundlePath>`;
 * `corsOrigins` comma-separated (`/re/` entries are RegExp); `outbound` `name=live|sink|off,...`.
 * `mailSink` is optional in the declaration (a service with no mail omits its key and receives
 * `stub`, which no row check applies to). `corsOrigins`, `cookieDomain`, `trustProxyHops`,
 * `devPerimeter`, `logFormat` and `logLevel` are optional too: an undeclared one is not read,
 * is `undefined`, and its row checks are skipped.
 */
export function createEnv(
  decl: CapabilityDeclaration,
  identity: EnvIdentity,
  config: ConfigSource
): Readonly<Capabilities> {
  const violations: string[] = [];

  function read<T>(
    cap: keyof Capabilities,
    parse: (raw: string) => Parsed<T>,
    optional = false
  ): T | undefined {
    const key = decl.keys[cap];
    if (key === undefined) {
      if (!optional) violations.push(`${cap}: no config key in the declaration`);
      return undefined;
    }
    const raw = config.get(key);
    if (raw === undefined) {
      violations.push(`${cap}: config key ${key} is missing`);
      return undefined;
    }
    const parsed = parse(raw);
    if (!parsed.ok) {
      violations.push(`${cap}: config key ${key} has an invalid value`);
      return undefined;
    }
    return parsed.value;
  }

  const credentialSource = read<CredentialSource>('credentialSource', r =>
    oneOf(r, ['iam-token', 'static'] as const)
  );
  const tls = read('tls', parseTls);
  const failFast = read('failFast', parseBool);
  const mailDeclared = decl.keys.mailSink !== undefined;
  const mailRead = read<MailSink>(
    'mailSink',
    r => oneOf(r, ['ses', 'stub', 'capture'] as const),
    true
  );
  const corsOrigins = read('corsOrigins', parseOrigins, true);
  const cookieDomain = read('cookieDomain', nonEmpty, true);
  const trustProxyHops = read('trustProxyHops', parseHops, true);
  const telemetryEnv = read('telemetryEnv', nonEmpty);
  const devPerimeter = read('devPerimeter', r => oneOf(r, ['on', 'off'] as const), true);
  const permissiveAuthz = read('permissiveAuthz', parseBool);
  const logFormat = read('logFormat', nonEmpty, true);
  const logLevel = read('logLevel', nonEmpty, true);

  let outbound: Record<string, OutboundBinding> | undefined;
  const outboundKey = decl.keys.outbound;
  if (outboundKey === undefined) {
    if (decl.outbound.length > 0) violations.push('outbound: no config key in the declaration');
    outbound = {};
  } else {
    const raw = config.get(outboundKey);
    if (raw === undefined) {
      if (decl.outbound.length > 0)
        violations.push(`outbound: config key ${outboundKey} is missing`);
      outbound = {};
    } else {
      const parsed = parseOutbound(raw, decl.outbound);
      for (const p of parsed.problems) violations.push(`${p} (config key ${outboundKey})`);
      outbound = parsed.bindings;
    }
  }

  const mailSink: MailSink | undefined = mailDeclared ? mailRead : 'stub';
  const outboundValues = Object.entries(outbound);
  const notIn = (allowed: readonly OutboundBinding[]) =>
    outboundValues.filter(([, b]) => !allowed.includes(b)).map(([n]) => n);

  const row = identity.row;
  const need = (ok: boolean | undefined, message: string) => {
    if (ok === false) violations.push(`${row}: ${message}`);
  };
  const defined = <T>(v: T | undefined, fn: (v: T) => boolean): boolean | undefined =>
    v === undefined ? undefined : fn(v);

  need(
    defined(permissiveAuthz, v => row === 'R4-local' || !v),
    'permissiveAuthz is legal only in the local row'
  );

  switch (row) {
    case 'R1-prod':
      need(failFast, 'failFast must be true');
      need(
        defined(credentialSource, v => v === 'iam-token'),
        'credentialSource must be iam-token'
      );
      need(
        defined(tls, v => v.required && v.caBundlePath !== undefined),
        'tls must be required with a pinned CA bundle'
      );
      if (mailDeclared)
        need(
          defined(mailSink, v => v === 'ses'),
          'mailSink must be ses'
        );
      for (const name of notIn(['live'])) violations.push(`${row}: outbound.${name} must be live`);
      need(
        defined(telemetryEnv, v => v === 'prod'),
        'telemetryEnv must be prod'
      );
      need(identity.telemetryEnv === 'prod', 'identity telemetryEnv (DD_ENV) must be prod');
      need(
        defined(devPerimeter, v => v === 'off'),
        'devPerimeter must be off'
      );
      need(
        defined(corsOrigins, v => !hasDevOrigin(v)),
        'corsOrigins must not include dev origins'
      );
      break;
    case 'R2-lane':
      need(failFast, 'failFast must be true');
      need(
        defined(credentialSource, v => v === 'iam-token'),
        'credentialSource must be iam-token'
      );
      need(
        defined(tls, v => v.required),
        'tls must be required'
      );
      need(
        defined(devPerimeter, v => v === 'off'),
        'devPerimeter must be off'
      );
      need(
        defined(telemetryEnv, v => v !== 'prod'),
        'telemetryEnv must not be prod'
      );
      need(identity.telemetryEnv !== 'prod', 'identity telemetryEnv (DD_ENV) must not be prod');
      if (mailDeclared)
        need(
          defined(mailSink, v => v === 'capture'),
          'mailSink must be capture'
        );
      for (const name of notIn(['sink', 'off']))
        violations.push(`${row}: outbound.${name} must be sink or off`);
      break;
    case 'R3-dev-overlay':
      need(
        defined(telemetryEnv, v => v === 'dev'),
        'telemetryEnv must be dev'
      );
      need(
        defined(mailSink, v => v === 'stub' || v === 'capture'),
        'mailSink must be stub or capture'
      );
      break;
    case 'R4-local':
      need(
        defined(credentialSource, v => v === 'static'),
        'credentialSource must be static'
      );
      need(
        defined(mailSink, v => v === 'stub' || v === 'capture'),
        'mailSink must be stub or capture'
      );
      for (const name of notIn(['off', 'sink']))
        violations.push(`${row}: outbound.${name} must be off or sink`);
      break;
  }

  if (violations.length > 0) throw new EnvInvariantError(row, violations);

  return Object.freeze({
    credentialSource: credentialSource as CredentialSource,
    tls: tls as TlsCapability,
    failFast: failFast as boolean,
    mailSink: mailSink as MailSink,
    corsOrigins,
    cookieDomain,
    trustProxyHops,
    telemetryEnv: telemetryEnv as string,
    devPerimeter,
    permissiveAuthz: permissiveAuthz as boolean,
    logFormat,
    logLevel,
    outbound: Object.freeze(outbound),
  });
}
