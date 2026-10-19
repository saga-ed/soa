import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { configs, rules } from '../eslint/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const base = { ecmaVersion: 2022 as const, sourceType: 'module' as const };
const js = new RuleTester({ parserOptions: base });
const ts = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: base,
});

const read = (name: string) => ({ messageId: 'envRead' as const, data: { name } });
const compare = { messageId: 'envCompare' as const };

js.run('no-env-identity', rules['no-env-identity'] as never, {
  valid: [
    { code: "const child = { env: { NODE_ENV: 'development' } };" },
    {
      code: "spawn('x', [], { env: { ...process.env, NODE_ENV: 'development', EXEC_ENV: 'dev' } });",
    },
    { code: "process.env.NODE_ENV = 'test';" },
    { code: "const mode = 'production'; if (mode === 'production') {}" },
    { code: "if (options.mode === 'prod') {}" },
    { code: "if (kind === 'prod') {}" },
    { code: 'const x = process.env.DATABASE_URL;' },
    { code: "if (env === 'development') {}" },
    { code: "if (stage === 'prod') {}" },
    { code: 'const { PORT } = process.env;' },
    { code: "const k = 'PORT'; process.env[k];" },
    {
      code: 'const e = process.env.NODE_ENV;',
      filename: '/repo/packages/node/env/src/load.ts',
    },
    {
      code: 'const e = process.env.NODE_ENV;',
      filename: '/repo/apps/node/svc/src/env/index.ts',
    },
    {
      code: "if (source === 'prod' || process.env.NODE_ENV) {}",
      filename: '/repo/apps/node/svc/src/bin/sync.ts',
      options: [
        { exempt: [{ glob: '**/bin/**', reason: 'CLI operator argument, not runtime identity' }] },
      ],
    },
    {
      code: 'export default { mode: process.env.NODE_ENV };',
      filename: '/repo/apps/node/svc/tsup.config.ts',
      options: [{ exempt: [{ glob: 'tsup.config.*', reason: 'build-time NODE_ENV' }] }],
    },
    {
      code: 'const e = process.env.LANE;',
      filename: '/repo/lib/boot.ts',
      options: [{ allow: ['lib/boot.ts'] }],
    },
  ],
  invalid: [
    { code: 'const e = process.env.NODE_ENV;', errors: [read('NODE_ENV')] },
    { code: 'const e = vars.EXEC_ENV;', errors: [read('EXEC_ENV')] },
    { code: 'foo(cfg.SAGA_ENV);', errors: [read('SAGA_ENV')] },
    { code: 'foo(a.b.LANE);', errors: [read('LANE')] },
    { code: 'foo(process.env.DD_ENV);', errors: [read('DD_ENV')] },
    { code: "const e = process.env['NODE_ENV'];", errors: [read('NODE_ENV')] },
    { code: 'const e = process.env[`EXEC_ENV`];', errors: [read('EXEC_ENV')] },
    { code: 'const e = process.env?.NODE_ENV;', errors: [read('NODE_ENV')] },
    { code: 'const { NODE_ENV } = process.env;', errors: [read('NODE_ENV')] },
    { code: 'const { NODE_ENV: nodeEnv, PORT } = process.env;', errors: [read('NODE_ENV')] },
    { code: "const { ['EXEC_ENV']: x } = process.env;", errors: [read('EXEC_ENV')] },
    { code: "const { LANE = 'none' } = vars;", errors: [read('LANE')] },
    {
      code: 'const { NODE_ENV, EXEC_ENV } = process.env;',
      errors: [read('NODE_ENV'), read('EXEC_ENV')],
    },
    { code: 'function f({ SAGA_ENV }) { return SAGA_ENV; }', errors: [read('SAGA_ENV')] },
    {
      code: "if (process.env.NODE_ENV === 'production') {}",
      errors: [read('NODE_ENV')],
    },
    {
      code: "const nodeEnv = process.env.NODE_ENV; if (nodeEnv === 'production') {}",
      errors: [read('NODE_ENV'), compare],
    },
    {
      code: "const { EXEC_ENV: execEnv } = process.env; if (execEnv !== 'prod') {}",
      errors: [read('EXEC_ENV'), compare],
    },
    {
      code: "const { EXEC_ENV } = process.env; if ('prod' == EXEC_ENV) {}",
      errors: [read('EXEC_ENV'), compare],
    },
    {
      code: "const e = (process.env.NODE_ENV ?? 'dev').trim(); if (e === 'staging') {}",
      errors: [read('NODE_ENV'), compare],
    },
    { code: "if (env === 'prod') {}", errors: [compare] },
    { code: "if (config.environment === 'production') {}", errors: [compare] },
    { code: "if (profile !== 'mirror') {}", errors: [compare] },
    { code: "if (laneName === 'twin') {}", errors: [compare] },
    { code: "if (getEnv() === 'staging') {}", errors: [compare] },
    { code: "if (process.env.APP_MODE === 'production') {}", errors: [compare] },
    { code: "if (settings.execEnv.toLowerCase() === 'prod') {}", errors: [compare] },
    {
      code: 'const e = process.env.NODE_ENV;',
      filename: '/repo/apps/node/svc/src/main.ts',
      options: [{ exempt: [{ glob: '**/bin/**', reason: 'CLI operator argument' }] }],
      errors: [read('NODE_ENV')],
    },
  ],
});

ts.run('no-env-identity (typescript syntax)', rules['no-env-identity'] as never, {
  valid: [
    { code: 'type T = typeof process.env.NODE_ENV;' },
    { code: "interface Env { NODE_ENV: string; EXEC_ENV?: 'prod' | 'dev' }" },
    { code: "type Name = 'NODE_ENV' | 'LANE'; const x: Name = 'LANE';" },
    { code: "const child = { env: { NODE_ENV: 'development' } as Record<string, string> };" },
    { code: "const mode: string = 'production'; if (mode === 'production') {}" },
  ],
  invalid: [
    { code: 'const e = process.env.NODE_ENV as string;', errors: [read('NODE_ENV')] },
    { code: 'const e = process.env.NODE_ENV!;', errors: [read('NODE_ENV')] },
    {
      code: "const nodeEnv = process.env.NODE_ENV as string; if (nodeEnv === 'production') {}",
      errors: [read('NODE_ENV'), compare],
    },
  ],
});

describe('configs.recommended', () => {
  it('registers the rule under the @saga-ed/soa-env plugin name as error', () => {
    const rec = configs.recommended;
    if (rec.plugins['@saga-ed/soa-env']?.rules['no-env-identity'] !== rules['no-env-identity'])
      throw new Error('plugin mismatch');
    if (rec.rules['@saga-ed/soa-env/no-env-identity'] !== 'error')
      throw new Error('rule not enabled');
  });
});
