import type { Capabilities } from './types.js';

/** R4-local identity capabilities with dev bindings; override any field per test. */
export function testEnv(overrides: Partial<Capabilities> = {}): Readonly<Capabilities> {
  return Object.freeze({
    credentialSource: 'static',
    tls: Object.freeze({ required: false }),
    failFast: false,
    mailSink: 'stub',
    corsOrigins: Object.freeze(['http://localhost:3000']),
    cookieDomain: 'localhost',
    trustProxyHops: 0,
    telemetryEnv: 'dev',
    devPerimeter: 'off',
    permissiveAuthz: false,
    logFormat: 'json',
    logLevel: 'debug',
    outbound: Object.freeze({}),
    ...overrides,
  });
}
