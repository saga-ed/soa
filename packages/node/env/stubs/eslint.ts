// Subpath export `@saga-ed/soa-env/eslint` (ESLint 8.57 legacy-compatible rule + flat-config preset).
import type { Rule } from 'eslint';

export interface NoEnvIdentityOptions {
    /** Globs where reads are legal. Default: the env module itself. */
    allow?: string[];
    /** Exempt file globs for CLI operator args and build config (reason required). */
    exempt?: { glob: string; reason: string }[];
}

export declare const rules: { 'no-env-identity': Rule.RuleModule };
export declare const configs: { recommended: unknown };

/** CI wrapper `soa-env-lint-ratchet`: `eslint --format json` vs an eslint-suppressions.json-shaped baseline. */
export interface RatchetBaseline {
    [file: string]: { '@saga-ed/soa-env/no-env-identity': { count: number } };
}
