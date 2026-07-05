import rootConfig from '../../../eslint.config.js';

/**
 * Package-local ESLint config for @saga-ed/saga-stack-cli.
 *
 * Extends the repo-root flat config and adds the CORE IMPORT-BOUNDARY rule:
 * `src/core/**` is the pure layer and MUST stay IO-free. It may not import
 * `node:child_process`, `node:fs`/`node:fs/promises`, network modules
 * (`node:http`/`node:https`/`node:net`/`node:dgram`/`node:tls`), or any
 * spawn/exec helper. Everything that touches the world lives in `src/runtime/**`.
 *
 * If the flat-config resolution above proves brittle in CI (the root config
 * imports from `packages/core/eslint-config`), the equivalent rule can be
 * lifted verbatim into the root `eslint.config.js` under a
 * `files: ['packages/node/saga-stack-cli/src/core/**']` block — see the TODO
 * at the bottom of this file.
 */
export default [
  ...rootConfig,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'child_process', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:child_process', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'fs', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:fs', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'fs/promises', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:fs/promises', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'http', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:http', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'https', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:https', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'net', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:net', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'dgram', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:dgram', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'tls', message: 'core/** must be pure — move IO to runtime/**.' },
            { name: 'node:tls', message: 'core/** must be pure — move IO to runtime/**.' },
          ],
          patterns: [
            { group: ['**/runtime/**'], message: 'core/** must not import from runtime/** (no IO in the pure layer).' },
          ],
        },
      ],
    },
  },
];

// TODO(M1): if root flat-config import resolution is brittle in CI, hoist the
// `no-restricted-imports` block above into the root eslint.config.js scoped to
// `packages/node/saga-stack-cli/src/core/**`.
