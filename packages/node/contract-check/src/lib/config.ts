import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PayloadDescriptor } from '@saga-ed/soa-event-envelope';

/**
 * Configuration the adopter repo provides to soa-contract-check. The tool is
 * layout-agnostic: each repo's config tells it where its events live, where
 * to write snapshots, and where to find pins files.
 */
export interface ContractCheckConfig {
    /**
     * Map from `<eventType>.v<version>` keys to PayloadDescriptors. Adopters
     * typically build this by spreading their per-family event registries
     * (e.g., `{ ...iamEvents, ...programsEvents }`).
     */
    registry: Record<string, PayloadDescriptor<unknown>>;
    /**
     * Absolute path to the directory holding committed JSON-Schema snapshots.
     * Recommended: `<repoRoot>/tools/contract-check/published`.
     */
    publishedDir: string;
    /**
     * Absolute glob matching pins YAML files. Recommended:
     * `<repoRoot>/apps/*&zwj;/pins/*.yaml`.
     *
     * Set to `null` if the repo has no apps/ layout (e.g., this very soa
     * package itself, which holds the tool but publishes no events). In that
     * case the pins layers are skipped entirely.
     */
    pinsGlob: string | null;
    /**
     * Optional `$id` prefix used in snapshot files (`https://…/<filename>`).
     * Defaults to `https://saga-ed.example.local/events/`. Affects bytes —
     * any change to this requires regenerating snapshots.
     */
    snapshotIdPrefix?: string;
}

/**
 * Identity helper that exists purely so adopters get TypeScript type-checking
 * on their `contract-check.config.ts` without having to remember the
 * `: ContractCheckConfig` annotation. Mirrors the `defineConfig` convention
 * used by vite, vitest, tsup, etc.
 *
 * @example
 *   import { defineConfig } from '@saga-ed/soa-contract-check';
 *   export default defineConfig({ registry, publishedDir, pinsGlob });
 */
export function defineConfig(config: ContractCheckConfig): ContractCheckConfig {
    return config;
}

/**
 * Verify that every `registry` key matches its descriptor's
 * `eventType` and `eventVersion`. The registry is keyed by string for
 * spreadability (`{ ...iamEvents, ...programsEvents }`) but the snapshot
 * filename is derived from the key while the pins-coverage layer is derived
 * from the descriptor's fields — so a drifting key would produce
 * inconsistent failures across the layers. Catch it loudly at entry.
 */
export function assertRegistryConsistent(config: ContractCheckConfig): void {
    for (const [eventKey, descriptor] of Object.entries(config.registry)) {
        const expected = `${descriptor.eventType}.v${descriptor.eventVersion}`;
        if (eventKey !== expected) {
            throw new Error(
                `contract-check: registry key '${eventKey}' does not match its descriptor (expected '${expected}'). ` +
                    'Each entry must be keyed by `${eventType}.v${eventVersion}` so the snapshot path and pins path agree.',
            );
        }
    }
}

const CONFIG_FILENAMES = [
    'contract-check.config.ts',
    'contract-check.config.mts',
    'contract-check.config.js',
    'contract-check.config.mjs',
];

/**
 * Find the contract-check config file by walking up from `cwd`. The repo root
 * is wherever the config sits — convention is that adopters put it next to
 * their `pnpm-workspace.yaml` or `package.json`.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<{
    config: ContractCheckConfig;
    configPath: string;
}> {
    let dir = resolve(cwd);
    for (;;) {
        for (const name of CONFIG_FILENAMES) {
            const candidate = resolve(dir, name);
            if (existsSync(candidate)) {
                const mod = (await import(pathToFileURL(candidate).href)) as {
                    default?: ContractCheckConfig;
                    config?: ContractCheckConfig;
                };
                const config = mod.default ?? mod.config;
                if (!config) {
                    throw new Error(
                        `${candidate} must default-export (or named-export \`config\`) a ContractCheckConfig object`,
                    );
                }
                return { config, configPath: candidate };
            }
        }
        const parent = resolve(dir, '..');
        if (parent === dir) {
            throw new Error(
                `Could not find a contract-check config file. Searched up from ${cwd} for: ${CONFIG_FILENAMES.join(', ')}`,
            );
        }
        dir = parent;
    }
}
