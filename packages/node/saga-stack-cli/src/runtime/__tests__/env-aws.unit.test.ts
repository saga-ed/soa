/**
 * `env-aws` pure arg-builder units (soa#355) — the byte shape of every `aws`
 * shell-out the `ss env` family makes. These builders are the only part of the
 * seam testable without spawning; the real `capture`/`portForward`/`lambdaInvoke`
 * IO is exercised through the command int tests' fakes.
 */

import { describe, expect, it } from 'vitest';
import { awsArgs, lambdaInvokeArgs, portForwardArgs } from '../env-aws.js';

describe('awsArgs — profile/region threading', () => {
  it('appends --profile and --region only when given', () => {
    expect(awsArgs(['sts', 'get-caller-identity'])).toEqual(['sts', 'get-caller-identity']);
    expect(awsArgs(['ssm', 'get-parameter'], { profile: 'dev_admin', region: 'us-west-2' })).toEqual([
      'ssm',
      'get-parameter',
      '--profile',
      'dev_admin',
      '--region',
      'us-west-2',
    ]);
    expect(awsArgs(['x'], { region: 'us-west-2' })).toEqual(['x', '--region', 'us-west-2']);
  });
});

describe('portForwardArgs — SSM start-session to a remote host', () => {
  it('builds the AWS-StartPortForwardingSessionToRemoteHost document with stringified ports', () => {
    const argv = portForwardArgs({
      target: 'i-0abc',
      host: 'db.dbs-v2.local',
      remotePort: 5440,
      localPort: 15432,
      region: 'us-west-2',
      profile: 'dev_admin',
    });
    expect(argv.slice(0, 6)).toEqual([
      'ssm',
      'start-session',
      '--target',
      'i-0abc',
      '--document-name',
      'AWS-StartPortForwardingSessionToRemoteHost',
    ]);
    const params = JSON.parse(argv[argv.indexOf('--parameters') + 1]!);
    expect(params).toEqual({ host: ['db.dbs-v2.local'], portNumber: ['5440'], localPortNumber: ['15432'] });
    expect(argv).toContain('--profile');
    expect(argv).toContain('dev_admin');
  });
});

describe('lambdaInvokeArgs — orchestrator invoke', () => {
  it('carries raw-in-base64-out, the 900s read timeout, the JSON payload, and the outfile last', () => {
    const argv = lambdaInvokeArgs(
      { functionName: 'dev-db-host-orchestrator', payload: { action: 'snapshot', serviceName: 'x', profile: 'pre-org-reset' }, region: 'us-west-2' },
      '/tmp/out.json',
    );
    expect(argv).toEqual([
      'lambda',
      'invoke',
      '--function-name',
      'dev-db-host-orchestrator',
      '--cli-binary-format',
      'raw-in-base64-out',
      '--cli-read-timeout',
      '900',
      '--payload',
      '{"action":"snapshot","serviceName":"x","profile":"pre-org-reset"}',
      '/tmp/out.json',
      '--region',
      'us-west-2',
    ]);
  });
});
