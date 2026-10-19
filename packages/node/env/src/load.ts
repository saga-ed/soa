import { createEnv } from './capabilities.js';
import { resolveAccount, type ResolveAccountOptions } from './account.js';
import { parseIdentity } from './identity.js';
import type {
  AccountResolver,
  Capabilities,
  CapabilityDeclaration,
  ConfigSource,
  Vars,
} from './types.js';

export interface LoadEnvOptions extends ResolveAccountOptions {
  resolver?: AccountResolver;
  /** Defaults to process.env. */
  vars?: Vars;
}

/** Boot entry: reads process.env once, resolves account, builds capabilities. The only process.env reader. */
export async function loadEnv(
  decl: CapabilityDeclaration,
  config: ConfigSource,
  options: LoadEnvOptions = {}
): Promise<Readonly<Capabilities>> {
  const vars: Vars = options.vars ?? process.env;
  const account = await resolveAccount(vars, options.resolver, options);
  return createEnv(decl, parseIdentity(vars, account), config);
}
