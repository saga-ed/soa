/**
 * verify-data — the PURE deep-DATA assertions for `stack verify --full` (M9; a
 * faithful port of verify.sh's `── data ──` section, ~81-122).
 *
 * `stack verify --full` must HARD-FAIL on an unseeded / unmigrated / mongo-unreachable
 * stack WITHOUT delegating the DATA half to verify.sh. This module maps the raw probe
 * outputs (a scalar psql read per check + two boolean readiness probes) to the five
 * pass/fail assertions verify.sh makes, plus verify.sh's `users==205` NOTE. It is
 * IO-free — the runtime (`stack verify`) gathers the readings through the `PgProbe`
 * scalar seam + `MeshExec`; this decides pass/fail.
 *
 *   D1  iam roster seeded          users > 0                      (HARD; 0 ⇒ fail, '' ⇒ unreachable fail)
 *   D2  deterministic dev id       SELECT 1 WHERE id=userId('dev') present   (HARD)
 *   D3  admin personas present     count(personas WHERE name='admin') ≥ 6    (HARD; #397 per-district admins)
 *   D4  sis_db migrated            _prisma_migrations present     (HARD)
 *   D5  connect-mongo reachable    mongosh ping ok                (HARD)
 *
 * `users == 205` is the canonical db:seed count (190 roster + 6 personas + dev + 8
 * Connect Demo) but a NON-205 count is NOT a failure — journey/partial seeds vary it.
 * It is surfaced as a NOTE only (plan hard constraint).
 *
 * DIVERGENCE (documented): the runtime reads these rows as `postgres_admin` (the mesh
 * superuser the existing `PgProbe` connects as), whereas verify.sh connects `-U iam`.
 * Both read the SAME rows in the same `iam_local` DB — the role only changes who
 * connects, not what `count(*) FROM users` returns.
 *
 * PURITY: no docker/psql/mongosh. `src/core/**` never imports `src/runtime/**`.
 */

/** The deterministic dev user id — `userId('dev')` from `@saga-ed/iam-seed-ids` (verify.sh:99). */
export const DEV_USER_ID = '1e2ca0d8-8f6a-5a97-a141-b38d472a1186';

/** The canonical `db:seed` roster count (190 roster + 6 personas + dev + 8 Connect Demo). */
export const CANONICAL_USERS = 205;

/** SQL for the three scalar DATA reads (run on `iam_local` as postgres_admin). */
export const DATA_SQL = {
  /** D1 — iam roster size. */
  users: 'SELECT count(*) FROM users',
  /** D2 — the deterministic dev id is present (⇒ seeded via db:seed, not random UUIDs). */
  devId: `SELECT 1 FROM users WHERE id='${DEV_USER_ID}'`,
  /** D3 — admin personas (seed + Lincoln + 4 per-district = 6, #397). */
  adminPersonas: "SELECT count(*) FROM personas WHERE name='admin'",
} as const;

/** The raw readings the runtime gathered for the DATA checks. */
export interface DataReadings {
  /** `count(*) FROM users` (trimmed scalar). `''` ⇒ iam_local unreachable. */
  usersRaw: string;
  /** `SELECT 1 … dev id` (trimmed scalar). `'1'` ⇒ present. */
  devIdRaw: string;
  /** `count(*) FROM personas WHERE name='admin'` (trimmed scalar). `''` ⇒ read error (0). */
  adminPersonasRaw: string;
  /** D4 — `_prisma_migrations` present in `sis_db` (`PgProbe.hasMigrationsTable`). */
  sisMigrated: boolean;
  /** D5 — connect-mongo answered a ping (`MeshExec.ready`). */
  mongoReachable: boolean;
}

/** One rendered DATA check. */
export interface DataCheck {
  id: 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
  /** Human line (mirrors verify.sh's `✓`/`✗` message text). */
  label: string;
  ok: boolean;
}

/** The DATA-check verdict. */
export interface DataAssessment {
  checks: DataCheck[];
  /** True iff every HARD check passed. */
  passed: boolean;
  /** Non-fatal notes (e.g. the `users != 205` observation). */
  notes: string[];
}

/** Parse a scalar count; `''`/non-numeric ⇒ `NaN` (an unreachable/errored read). */
function parseCount(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Assess the five DATA checks from the raw readings. HARD checks flip `passed`;
 * `users != 205` is recorded as a NOTE only (never a failure).
 */
export function assessData(r: DataReadings): DataAssessment {
  const checks: DataCheck[] = [];
  const notes: string[] = [];

  // D1 — iam roster seeded (users > 0). '' ⇒ iam_local unreachable (mesh down).
  const users = parseCount(r.usersRaw);
  if (Number.isNaN(users)) {
    checks.push({ id: 'D1', label: 'iam_local unreachable (is the mesh up?)', ok: false });
  } else if (users > 0) {
    checks.push({ id: 'D1', label: `iam roster seeded — users=${users}`, ok: true });
    // NOTE (never a failure): flag a non-canonical count.
    if (users !== CANONICAL_USERS) {
      notes.push(
        `note: users=${users} — canonical db:seed is ${CANONICAL_USERS} (190 roster+6 personas+dev+8 demo)`,
      );
    }
  } else {
    checks.push({ id: 'D1', label: 'iam roster EMPTY (users=0) — run: stack up --reset --seed roster', ok: false });
  }

  // D2/D3 are only MEANINGFUL when iam_local is reachable AND non-empty — verify.sh
  // evaluates them INSIDE its `users > 0` branch. When users is NaN (unreachable) or 0
  // (empty) the dev-id/admin-persona reads are empty for the SAME reason D1 already
  // failed, so printing "uses random ids" / "#397 not seeded" MISATTRIBUTES the cause.
  // Relabel both as skipped (root cause = the unreachable/empty iam_local D1 already
  // reports); ok stays false so the gate still hard-fails on the real gap (never green).
  const iamUsable = !Number.isNaN(users) && users > 0;

  // D2 — deterministic dev id present (⇒ seeded via db:seed, not random UUIDs).
  const devPresent = r.devIdRaw.trim() === '1';
  checks.push({
    id: 'D2',
    label: !iamUsable
      ? 'deterministic dev id — skipped (iam_local unreachable/empty; see D1)'
      : devPresent
        ? "deterministic ids present (dev = userId('dev'))"
        : 'deterministic dev id absent — not seeded via db:seed (scenario uses random ids)',
    ok: iamUsable && devPresent,
  });

  // D3 — admin personas ≥ 6 (seed + Lincoln + 4 per-district, #397).
  const admin = parseCount(r.adminPersonasRaw);
  const adminOk = Number.isFinite(admin) && admin >= 6;
  checks.push({
    id: 'D3',
    label: !iamUsable
      ? 'admin personas — skipped (iam_local unreachable/empty; see D1)'
      : adminOk
        ? `admin personas present (${admin} — incl 4 per-district, #397)`
        : `admin personas=${Number.isNaN(admin) ? 0 : admin} (<6) — per-district admins missing (#397 not seeded)`,
    ok: iamUsable && adminOk,
  });

  // D4 — sis_db migrated.
  checks.push({
    id: 'D4',
    label: r.sisMigrated ? 'sis_db migrated' : 'sis_db not migrated (run stack up — prep deploys the schema)',
    ok: r.sisMigrated,
  });

  // D5 — connect-mongo reachable (reachability IS the data check; collections auto-create).
  checks.push({
    id: 'D5',
    label: r.mongoReachable
      ? 'connect-mongo reachable (:27037)'
      : 'connect-mongo unreachable (run stack up — mesh_up starts it)',
    ok: r.mongoReachable,
  });

  return { checks, passed: checks.every((c) => c.ok), notes };
}
