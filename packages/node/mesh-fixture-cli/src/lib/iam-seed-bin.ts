/**
 * Resolver for the iam-seed child-process binary.
 *
 * Mirrors ads-adm-seed-bin's IAM_SEED_BIN env override + default at the
 * dev/rostering worktree path. iam-seed inherits parent stdio (no UUID
 * post-processing needed today — Phase C orchestrator runs the bin
 * end-to-end against the entire TARGETS set, not single-program writes
 * that the registry artifact map keys by).
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_IAM_SEED_BIN = resolve(
  homedir(),
  'dev/rostering/packages/node/iam-seed/dist/bin/iam-seed.js',
);

export function resolveIamSeedBin(): string {
  return process.env['IAM_SEED_BIN'] ?? DEFAULT_IAM_SEED_BIN;
}
