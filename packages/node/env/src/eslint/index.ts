import { noEnvIdentity, type NoEnvIdentityOptions, type RuleModule } from './rule.js';

export type { NoEnvIdentityOptions, RuleModule };
export { runRatchet, compareToBaseline, countByFile, RATCHET_RULE_ID } from './ratchet.js';
export type { RatchetBaseline, RatchetDeps } from './ratchet.js';

export const rules: { 'no-env-identity': RuleModule } = { 'no-env-identity': noEnvIdentity };

export const plugin = { meta: { name: '@saga-ed/soa-env' }, rules };

/** Flat-config preset (ESLint 8.57 flat config or later). */
export const configs: {
  recommended: { plugins: Record<string, typeof plugin>; rules: Record<string, string> };
} = {
  recommended: {
    plugins: { '@saga-ed/soa-env': plugin },
    rules: { '@saga-ed/soa-env/no-env-identity': 'error' },
  },
};
