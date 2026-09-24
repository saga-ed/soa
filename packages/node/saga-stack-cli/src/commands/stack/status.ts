/**
 * `saga-stack stack status` — NATIVE manifest-derived health report (plan §2.4,
 * §7.2 "M2").
 *
 * RE-IMPLEMENTED in M2: instead of shelling out to `up.sh --status`, status now
 * derives its probe list straight from the MANIFEST (`core/probe-plan`) and GETs
 * each service's `<stack-lane>/<healthPath>` through the injectable HealthProber
 * (`this.getProber()`). Deriving the list from the manifest closes the gap that
 * verify.sh had (it hand-maintained ~10 endpoints and missed content-api
 * `:3009/health`); here content-api is covered automatically because it is in
 * the manifest.
 *
 * SCOPE: `--only <svc,…>` scopes the report to a dependency closure (so you can
 * status just the subset you brought up); `--with <bundle>` is sugar over
 * `--only` that unions a named bundle's services into that closure (`--with
 * playback` scopes to the optional playback services). With neither, status
 * probes every NON-optional service.
 *
 * READ-ONLY: status never exits non-zero on its own — a down service is REPORTED
 * (and reflected in the JSON `healthy` field / exit-free text), not raised as an
 * error of the command. The injectable prober NEVER throws (a down endpoint is
 * `{ ok:false }`), so the table always renders.
 *
 *   node bin/dev.js stack status
 *   node bin/dev.js stack status --only connect-web --output-json
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { BUNDLE_NAMES, combineRequested, featuresOf } from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { healthProbes } from '../../core/probe-plan.js';
import { manifest } from '../../core/manifest/index.js';
import type { RepoKey, ServiceId } from '../../core/manifest/index.js';
import { resolveRepoRoot } from '../../runtime/index.js';
import { repoContextFromFlags } from '../../runtime/index.js';
import type { ScriptContext } from '../../runtime/index.js';
import { isProvenanceProblem, type ProvenanceRow } from '../../core/provenance.js';

export default class StackStatus extends BaseCommand {
  static description =
    'Show per-service health, probing manifest-derived endpoints (native; read-only).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --only connect-web',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'scope the health report to the dependency closure of these services (comma-list)',
    }),
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) to include — sugar over --only (unions the bundle's services into the closure). Repeatable/composable: --with dash --with coach. Bundles: dash, connect, coach, playback.",
    }),
    provenance: Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'also check that each listener is serving the checkout ss resolves for it, and started after that checkout last moved (--no-provenance to skip). Reports problems only; --output-json carries every verdict.',
    }),
  };

  /** M7 Phase 2: `stack status` probes a slot's offset ports at slot > 0. */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `--set` probes the set's slot with the set's repo pins. */
  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackStatus);

    // M7: the slot profile drives the offset probe ports + the slot>0 exclusion.
    // At slot 0 it's the byte-identical no-offset default (base ports, no exclusion).
    const profile = deriveInstance({ slot: flags.slot });
    let ids = resolveServiceSet(flags.only, flags.with, (msg) => this.error(msg));
    // At slot > 0 the literal-port services aren't brought up (see `stack up`), so
    // don't report them as down here either.
    if (profile.slot > 0) {
      const excluded = new Set(profile.excludedServices);
      ids = ids.filter((id) => !excluded.has(id));
    }

    // A service whose sibling repo isn't cloned is reported not-cloned, not probed
    // (and excluded from the healthy verdict) — consistent with `stack up`'s skip.
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const { probe, notCloned } = partitionByRepoPresence(ids, ctx, this.getRepoDirCheck());
    const probes = healthProbes(manifest, probe, profile.portOverrides);

    const prober = this.getProber();
    const rows = await Promise.all(
      probes.map(async (probe) => {
        const result = await prober.probe(probe.url);
        return { ...probe, ok: result.ok, status: result.status };
      }),
    );

    const up = rows.filter((r) => r.ok).length;
    const down = rows.length - up;
    const healthy = down === 0; // not-cloned services do NOT count as down

    // Provenance is a SEPARATE question from health: a 200 says something is
    // answering, not that it is answering with the code on disk. Assessed only
    // for services we actually probed, and never folded into `healthy` — see the
    // note on the JSON payload below.
    const provenance = flags.provenance
      ? await this.getProvenance().assess({
          manifest,
          services: probe,
          portOverrides: profile.portOverrides,
          expectedRoots: new Map(
            probe.map((id) => [id, resolveRepoRoot(manifest.services[id].repo, ctx)]),
          ),
        })
      : [];
    const suspect = provenance.filter((p) => isProvenanceProblem(p.verdict));
    const byId = new Map(provenance.map((p) => [p.id, p]));

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            services: rows.map((r) => ({
              id: r.id,
              url: r.url,
              ok: r.ok,
              status: r.status ?? null,
            })),
            notCloned: notCloned.map((n) => ({ id: n.id, repo: n.repo, repoDir: n.repoDir })),
            // `healthy` deliberately still means "every probed service answered".
            // Provenance gets its OWN verdict so anything gating on `healthy`
            // keeps its existing meaning instead of silently tightening.
            provenance: provenance.map((p) => ({
              id: p.id,
              port: p.port,
              verdict: p.verdict,
              pid: p.pid,
              expectedRoot: p.expectedRoot,
              actualRoot: p.actualRoot,
              startedAt: p.startedAtMs === null ? null : new Date(p.startedAtMs).toISOString(),
              refMovedAt: p.refMovedAtMs === null ? null : new Date(p.refMovedAtMs).toISOString(),
            })),
            summary: {
              total: rows.length,
              up,
              down,
              notCloned: notCloned.length,
              suspect: suspect.length,
            },
            healthy,
            provenanceOk: suspect.length === 0,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (flags.porcelain) {
      for (const r of rows) this.log(`${r.id}=${r.ok ? 'up' : 'down'}`);
      for (const n of notCloned) this.log(`${n.id}=not-cloned`);
      for (const p of suspect) this.log(`provenance.${p.id}=${p.verdict}`);
      this.log(`healthy=${healthy}`);
      this.log(`provenanceOk=${suspect.length === 0}`);
      return;
    }

    for (const r of rows) {
      this.log(formatRow(r, byId.get(r.id)));
      for (const line of provenanceDetail(byId.get(r.id))) this.log(line);
    }
    for (const n of notCloned) {
      this.log(`⚠ ${n.id.padEnd(16)} ${n.repoDir}  (not cloned: ${n.repo} repo not present)`);
    }
    this.log(
      `${up}/${rows.length} services up${healthy ? '' : ` (${down} down)`}` +
        (notCloned.length ? `, ${notCloned.length} not cloned` : '') +
        (suspect.length ? ` · ⚠ ${suspect.length} serving unverified code` : ''),
    );
  }
}

/** A rendered probe row (probe + its outcome). */
interface StatusRow {
  id: ServiceId;
  url: string;
  ok: boolean;
  status?: number;
}

/**
 * Human line: `✓ id   url   (200)` for up, `✗ id   url   (down)` for down. A
 * service that answers but whose provenance is suspect is marked `⚠` and
 * labelled, because a bare `✓` on a process serving week-old code is exactly the
 * false reassurance this check exists to remove.
 */
function formatRow(r: StatusRow, p?: ProvenanceRow): string {
  const suspect = p !== undefined && isProvenanceProblem(p.verdict);
  const mark = suspect ? '⚠' : r.ok ? '✓' : '✗';
  const code = r.status !== undefined ? `(${r.status})` : '(down)';
  const label = suspect ? `  ${p.verdict === 'stale' ? 'STALE' : 'WRONG CHECKOUT'}` : '';
  return `${mark} ${r.id.padEnd(16)} ${r.url}  ${code}${label}`;
}

/** Render `ms` as a local `YYYY-MM-DD HH:MM`, or `?` when unknown. */
function stamp(ms: number | null): string {
  if (ms === null) return '?';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `6d` / `3h` / `12m` — how far `earlier` precedes `later`; '' if either is unknown. */
function gap(earlier: number | null, later: number | null): string {
  if (earlier === null || later === null) return '';
  const mins = Math.max(0, Math.round((later - earlier) / 60000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h`;
  return `${mins}m`;
}

/**
 * The indented explanation under a suspect service. Says what is wrong, what was
 * expected, and — for `stale` — how far behind the process is, so the operator
 * can act without re-deriving it by hand.
 */
function provenanceDetail(p?: ProvenanceRow): string[] {
  if (p === undefined || !isProvenanceProblem(p.verdict)) return [];
  const out: string[] = [];
  if (p.verdict === 'wrong-checkout') {
    out.push(`    serving from  ${p.actualRoot ?? '?'}`);
    out.push(`    expected      ${p.expectedRoot}`);
  } else {
    const behind = gap(p.startedAtMs, p.refMovedAtMs);
    out.push(`    checkout      ${p.expectedRoot}`);
    out.push(
      `    started       ${stamp(p.startedAtMs)}  ·  HEAD moved ${stamp(p.refMovedAtMs)}` +
        (behind ? `  (${behind} behind)` : ''),
    );
  }
  out.push(`    pid ${p.pid ?? '?'} — restart this service to serve what is on disk`);
  return out;
}

/**
 * Turn the `--only`/`--with` flags into the ordered service-id list to probe.
 * The requested set is `parseOnly(only) ∪ expandBundles(with)`; each `--with
 * <bundle>` also selects that feature, so the bundle's optional service ids
 * survive the closure's optional filter.
 *  - EMPTY requested (no `--only`, no `--with`) ⇒ every NON-optional service.
 *  - else ⇒ the dependency closure of the requested set (launch order).
 * `fail` renders a friendly oclif error and does not return. Shared by
 * `stack status` and `stack verify` (and mirrors `stack up`'s resolution).
 */
export function resolveServiceSet(
  only: string | undefined,
  withBundles: string[] | undefined,
  fail: (msg: string) => never,
): ServiceId[] {
  const requested = combineRequested(only, withBundles, fail);

  if (requested.length === 0) {
    return (Object.keys(manifest.services) as ServiceId[]).filter(
      (id) => !manifest.services[id].optional,
    );
  }

  const known = new Set(Object.keys(manifest.services));
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    fail(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
  }

  // Features come from the bundle flags AND from any explicitly-requested ids —
  // naming an optional service is itself a request for it (see `featuresFor`).
  return computeClosure(manifest, requested, {
    features: featuresOf(withBundles, requested),
  }).services;
}

/** A service excluded from the health pass because its sibling repo isn't cloned. */
export interface NotClonedService {
  id: ServiceId;
  repo: RepoKey;
  repoDir: string;
}

// M15: the ScriptContext builder is now THE shared one in runtime/repos.ts —
// re-exported so verify/overlay/bootstrap's existing imports keep working.
export { repoContextFromFlags };

/**
 * Partition a resolved service set by whether each service's sibling-repo checkout
 * is present on disk. A service whose repo dir is ABSENT is reported as
 * not-cloned (and excluded from the health pass/fail) rather than probed-and-down,
 * so `status`/`verify` stay consistent with `stack up`'s skip guard: a missing
 * coach checkout does not redden the stack. Shared by both commands.
 */
export function partitionByRepoPresence(
  ids: ServiceId[],
  ctx: ScriptContext,
  repoDirExists: (dir: string) => boolean,
): { probe: ServiceId[]; notCloned: NotClonedService[] } {
  const probe: ServiceId[] = [];
  const notCloned: NotClonedService[] = [];
  for (const id of ids) {
    const repo = manifest.services[id].repo;
    const repoDir = resolveRepoRoot(repo, ctx);
    if (repoDirExists(repoDir)) probe.push(id);
    else notCloned.push({ id, repo, repoDir });
  }
  return { probe, notCloned };
}
