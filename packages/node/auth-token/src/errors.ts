export type VerifyFailure =
  | 'expired'
  | 'invalid-issuer'
  | 'invalid-audience'
  | 'unknown-key'
  | 'invalid-signature'
  | 'malformed'
  | 'missing-claims';

export type VerifyResult =
  | { ok: true; claims: import('./claims.js').JanusClaims }
  | { ok: false; reason: VerifyFailure; detail?: string };

export class JanusVerifyError extends Error {
  constructor(public readonly reason: VerifyFailure, detail?: string) {
    super(`Janus token verify failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'JanusVerifyError';
  }
}
