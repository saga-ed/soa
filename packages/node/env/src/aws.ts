import type { AccountResolver } from './types.js';

export interface StsAccountResolverOptions {
  region?: string;
}

/** STS `GetCallerIdentity` account lookup. Requires the optional peer `@aws-sdk/client-sts`. */
export function createStsAccountResolver(options: StsAccountResolverOptions = {}): AccountResolver {
  return async () => {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const client = new STSClient(options.region ? { region: options.region } : {});
    try {
      const out = await client.send(new GetCallerIdentityCommand({}));
      return out.Account;
    } finally {
      client.destroy();
    }
  };
}
