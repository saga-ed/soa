/**
 * LiveKit fleek-cluster creds fetch — arg construction + JSON parsing, asserted
 * over a FAKE `LivekitCredsIo` (no real `aws`/`tunnel.sh` spawn). Mirrors up.sh's
 * `qboard/fleek/livekit-creds` pull: resolve the AWS profile from `tunnel.sh
 * aws-profile`, then `aws secretsmanager get-secret-value`, then pull
 * `api_key`/`api_secret`. Best-effort: any miss ⇒ null (dev-key fallback).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LIVEKIT_SECRET_ID,
  LIVEKIT_SECRET_REGION,
  livekitSecretArgs,
  makeRealLivekitCredsFetch,
  parseLivekitSecret,
} from '../livekit-creds.js';
import type { LivekitCredsIo } from '../livekit-creds.js';

/** A fake IO: answer `aws-profile` then the `aws` call from canned strings; record calls. */
function fakeIo(over: { profile?: string; secret?: string } = {}): {
  io: LivekitCredsIo;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const io: LivekitCredsIo = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'aws-profile') return over.profile ?? '';
      return over.secret ?? '';
    },
  };
  return { io, calls };
}

describe('parseLivekitSecret', () => {
  it('extracts api_key/api_secret from the SecretString JSON', () => {
    expect(parseLivekitSecret('{"api_key":"K1","api_secret":"S1"}')).toEqual({ apiKey: 'K1', apiSecret: 'S1' });
  });
  it('returns null on missing api_secret, empty, or malformed JSON', () => {
    expect(parseLivekitSecret('{"api_key":"K1"}')).toBeNull();
    expect(parseLivekitSecret('')).toBeNull();
    expect(parseLivekitSecret('not json')).toBeNull();
  });
});

describe('livekitSecretArgs', () => {
  it('reads the up.sh secret id + region, and adds --profile only when set', () => {
    expect(LIVEKIT_SECRET_ID).toBe('qboard/fleek/livekit-creds');
    expect(LIVEKIT_SECRET_REGION).toBe('us-west-2');
    const withP = livekitSecretArgs('myprofile');
    expect(withP).toContain('--secret-id');
    expect(withP).toContain(LIVEKIT_SECRET_ID);
    expect(withP).toContain('--region');
    expect(withP).toContain(LIVEKIT_SECRET_REGION);
    expect(withP.join(' ')).toContain('--profile myprofile');
    expect(livekitSecretArgs('').join(' ')).not.toContain('--profile');
  });
});

describe('makeRealLivekitCredsFetch', () => {
  it('resolves creds: aws-profile → aws get-secret-value → parsed key/secret', async () => {
    const { io, calls } = fakeIo({ profile: 'sso-dev', secret: '{"api_key":"realK","api_secret":"realS"}' });
    const creds = await makeRealLivekitCredsFetch(io)('/w/vendor/tunnel.sh');
    expect(creds).toEqual({ apiKey: 'realK', apiSecret: 'realS' });
    // first call resolves the profile via the vendored tunnel.sh …
    expect(calls[0]).toMatchObject({ command: '/w/vendor/tunnel.sh', args: ['aws-profile'] });
    // … then the aws call carries the resolved profile.
    expect(calls[1]?.command).toBe('aws');
    expect(calls[1]?.args.join(' ')).toContain('--profile sso-dev');
  });

  it('omits --profile when tunnel.sh aws-profile is empty (default cred chain)', async () => {
    const { io, calls } = fakeIo({ profile: '', secret: '{"api_key":"K","api_secret":"S"}' });
    await makeRealLivekitCredsFetch(io)('/w/vendor/tunnel.sh');
    expect(calls[1]?.args.join(' ')).not.toContain('--profile');
  });

  it('returns null (dev-key fallback) when the secret is inaccessible', async () => {
    const { io } = fakeIo({ profile: 'p', secret: '' }); // aws failed / no access
    expect(await makeRealLivekitCredsFetch(io)('/w/vendor/tunnel.sh')).toBeNull();
  });

  it('defaults to the real execFile IO when none is injected (smoke — does not throw)', () => {
    expect(typeof makeRealLivekitCredsFetch()).toBe('function');
    expect(vi.isMockFunction(makeRealLivekitCredsFetch())).toBe(false);
  });
});
