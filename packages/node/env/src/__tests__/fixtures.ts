import type { CapabilityDeclaration, ConfigSource, InvariantRow } from '../types.js';

export const decl: CapabilityDeclaration = {
  service: 'svc-api',
  outbound: ['clever', 'lake-export'],
  keys: {
    credentialSource: 'CRED',
    tls: 'TLS',
    failFast: 'FAIL_FAST',
    mailSink: 'MAIL',
    corsOrigins: 'CORS',
    cookieDomain: 'COOKIE',
    trustProxyHops: 'HOPS',
    telemetryEnv: 'TELEMETRY',
    devPerimeter: 'PERIMETER',
    permissiveAuthz: 'PERMISSIVE',
    logFormat: 'LOG_FORMAT',
    logLevel: 'LOG_LEVEL',
    outbound: 'OUTBOUND',
  },
};

const common = {
  CORS: 'https://app.example.org',
  COOKIE: '.example.org',
  HOPS: '1',
  LOG_FORMAT: 'json',
  LOG_LEVEL: 'info',
  PERMISSIVE: 'false',
};

export const validConfig: Record<InvariantRow, Record<string, string>> = {
  'R1-prod': {
    ...common,
    CRED: 'iam-token',
    TLS: 'required:/etc/ssl/rds-ca.pem',
    FAIL_FAST: 'true',
    MAIL: 'ses',
    TELEMETRY: 'prod',
    PERIMETER: 'off',
    OUTBOUND: 'clever=live,lake-export=live',
  },
  'R2-lane': {
    ...common,
    CRED: 'iam-token',
    TLS: 'required',
    FAIL_FAST: 'true',
    MAIL: 'capture',
    TELEMETRY: 'twin',
    PERIMETER: 'off',
    OUTBOUND: 'clever=sink,lake-export=off',
  },
  'R3-dev-overlay': {
    ...common,
    CRED: 'static',
    TLS: 'off',
    FAIL_FAST: 'false',
    MAIL: 'stub',
    TELEMETRY: 'dev',
    PERIMETER: 'on',
    OUTBOUND: 'clever=live,lake-export=live',
  },
  'R4-local': {
    ...common,
    CRED: 'static',
    TLS: 'off',
    FAIL_FAST: 'false',
    MAIL: 'stub',
    TELEMETRY: 'dev',
    PERIMETER: 'off',
    OUTBOUND: 'clever=off,lake-export=sink',
  },
};

export function source(values: Record<string, string>): ConfigSource {
  return { get: key => values[key] };
}
