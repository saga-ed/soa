import { TIMEOUT } from '../readiness.js';
import type { ProbeReason } from './types.js';

const TLS_CODES = /^(CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|UNABLE_TO_GET_ISSUER|HOSTNAME_MISMATCH)/;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA']);
const AUTH_CODES = new Set(['28P01', '28000', 'P1000', 'NOAUTH', 'WRONGPASS', 'ACCESSDENIED', 'ACCESS_REFUSED']);
const SCHEMA_CODES = new Set(['P2021', 'P2022', '42P01', '42703']);
const POOL_CODES = new Set(['P2024']);
const AUTH_NAMES = /(AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|Unauthorized|Forbidden|InvalidClientTokenId)/i;
const AUTH_MSG = /(password authentication|authentication failed|access denied|unauthorized|forbidden|invalid credentials|token (is )?expired)/i;
const POOL_MSG = /(timed out fetching a new connection|pool|too many (clients|connections)|connection timeout)/i;

/** Maps a raw driver error to a closed reason. The raw message is never exposed. */
export function classifyError(err: unknown): ProbeReason {
  if (err === TIMEOUT) return 'timeout';
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (POOL_CODES.has(code) || (code === '' && POOL_MSG.test(message) && !/auth/i.test(message))) return 'pool_exhausted';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (DNS_CODES.has(code)) return 'dns';
  if (TLS_CODES.test(code)) return 'tls';
  if (AUTH_CODES.has(code.toUpperCase()) || AUTH_NAMES.test(name) || AUTH_MSG.test(message)) return 'auth';
  if (SCHEMA_CODES.has(code)) return 'schema';
  if (code === 'ETIMEDOUT' || name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'error';
}
