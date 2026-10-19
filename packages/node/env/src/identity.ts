import { EnvIdentityError } from './errors.js';
import { parseLane } from './lane.js';
import type { EnvIdentity, InvariantRow, Lane, Profile, ResolvedAccount, Vars } from './types.js';

function parseExecEnv(vars: Vars): 'prod' | 'dev' | undefined {
  const raw = vars['EXEC_ENV'];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'mirror') {
    throw new EnvIdentityError(
      'EXEC_ENV=mirror is not accepted: set LANE=mirror (infra-set) and EXEC_ENV=prod'
    );
  }
  if (value === 'prod' || value === 'dev') return value;
  throw new EnvIdentityError('EXEC_ENV must be prod or dev (or unset)');
}

function selectRow(account: ResolvedAccount, lane: Lane): InvariantRow {
  switch (account.kind) {
    case 'local':
      if (lane !== 'none') {
        throw new EnvIdentityError('SAGA_LOCAL=1 conflicts with LANE; a local run has no lane');
      }
      return 'R4-local';
    case 'prod':
      if (lane !== 'none') {
        throw new EnvIdentityError(`lane ${lane} cannot run in the prod account`);
      }
      return 'R1-prod';
    case 'dev':
      return lane === 'none' ? 'R3-dev-overlay' : 'R2-lane';
  }
}

function defaultTelemetryEnv(account: ResolvedAccount): string {
  return account.kind;
}

/**
 * Pure identity parse. The row is keyed on account x lane; profile is derived from `EXEC_ENV`
 * (anything but an explicit `dev` is the prod profile) and never selects the row.
 * Unknown or conflicting values throw EnvIdentityError. `EXEC_ENV=dev` is a transitional input
 * accepted only for row R3.
 */
export function parseIdentity(vars: Vars, account: ResolvedAccount): EnvIdentity {
  const laneParse = parseLane(vars);
  if (laneParse.lane === 'invalid') throw new EnvIdentityError(laneParse.reason);
  const execEnv = parseExecEnv(vars);
  const row = selectRow(account, laneParse.lane);
  if (execEnv === 'dev' && row !== 'R3-dev-overlay') {
    throw new EnvIdentityError(
      `EXEC_ENV=dev conflicts with row ${row}; EXEC_ENV=dev is valid only on dev-main`
    );
  }
  const profile: Profile = execEnv === 'dev' ? 'dev' : 'prod';
  const ddEnv = vars['DD_ENV']?.trim();
  return {
    profile,
    lane: laneParse.lane,
    telemetryEnv: ddEnv ? ddEnv : defaultTelemetryEnv(account),
    account,
    row,
  };
}
