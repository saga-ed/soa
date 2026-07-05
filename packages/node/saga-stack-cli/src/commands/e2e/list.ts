/**
 * `saga-stack e2e list` — list discoverable SPAs, their flows, and phases (M5).
 *
 * Replaces the M2 thin shell over `check-e2e.sh --help`. Walks the built-in SPA
 * registry, discovers + loads each SPA's `flows.json` (registry repo path, or the
 * bundled example for the built-in `saga-dash` id when the repo hasn't authored
 * one yet), and prints the flows + their stages/phases. READ-ONLY: it touches no
 * docker / pnpm / stack and never fails on its own — a SPA with no authored
 * flows.json is simply reported as "not authored yet".
 *
 *   node bin/dev.js e2e list
 *   node bin/dev.js e2e list --output-json
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { checkpointFixtureId, evaluateCheckpoint, knownSpaIds, stagePrefixHash } from '../../core/flow/index.js';
import { discoverFlowManifest } from '../../e2e-orchestrate.js';

export default class E2eList extends BaseCommand {
  static description = 'List discoverable SPAs, their e2e flows, and phases (reads flows.json / the bundled example).';

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --output-json'];

  static flags = {
    ...BaseCommand.baseFlags,
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
  };

  /**
   * M13-A: `e2e list --set <name>` browses THAT worktree's flows.json —
   * read-only discovery, so both opt-ins are safe (the injected slot is inert
   * here; it only satisfies the central guard for a set bound to slot ≥ 1).
   */
  protected slotAware(): boolean {
    return true;
  }

  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(E2eList);

    // M14-C: annotate stages with baked-checkpoint freshness. The slot env
    // seam must be applied FIRST — snapshotsRoot() reads $SAGA_MESH_* at call
    // time, so a --set/--slot listing checks ITS slot's snapshot root.
    this.applyInstanceEnv(deriveInstance({ slot: flags.slot }));
    const checkpoints = this.getCheckpointStore(this.scriptContextFromFlags(flags));
    const now = new Date(); // once — a listing must not straddle a midnight boundary

    const spas: Record<string, unknown>[] = [];
    const lines: string[] = [];

    for (const spaId of knownSpaIds()) {
      try {
        const disco = discoverFlowManifest(spaId, flags, process.env);
        const m = disco.manifest;

        /** M14-C per-stage checkpoint verdict: valid | needs-re-bake | none. */
        const ckpt = (f: (typeof m.flows)[number], i: number): 'valid' | 'stale' | null => {
          if (!f.progressive) return null;
          const stage = f.stages[i];
          if (stage === undefined) return null;
          const manifest = checkpoints.load(checkpointFixtureId(m.spa.id, f.name, stage, i + 1));
          if (manifest === null) return null;
          // seedProfile/spaHead deliberately omitted (WARN-only / unknowable here);
          // identity + prefixHash + staleness give the honest listing verdict.
          const verdict = evaluateCheckpoint(
            manifest.flow,
            {
              spaId: m.spa.id,
              flowName: f.name,
              stageId: stage.id,
              prefixHash: stagePrefixHash(f, f.stages.slice(0, i + 1)),
            },
            now,
          );
          return verdict.ok ? 'valid' : 'stale';
        };

        spas.push({
          id: m.spa.id,
          system: m.spa.system,
          source: disco.usedBundledExample ? 'bundled-example' : disco.sourcePath,
          appDir: m.spa.appDir,
          flows: m.flows.map((f) => ({
            name: f.name,
            description: f.description,
            lanes: f.lanes,
            progressive: f.progressive,
            foreground: f.foreground ?? false,
            av: f.av ?? false,
            prerequisite: f.prerequisite ?? null,
            stages: f.stages.map((s, i) => ({
              id: s.id,
              phase: s.phase ?? null,
              project: s.project,
              tags: s.tags ?? [],
              checkpoint: ckpt(f, i),
            })),
          })),
        });

        lines.push(
          `${m.spa.id}  [${m.spa.system}]  ${disco.usedBundledExample ? '(bundled example — repo has not authored flows.json)' : disco.sourcePath}`,
        );
        for (const f of m.flows) {
          const tags = [f.progressive ? 'progressive' : 'single', ...(f.foreground ? ['foreground'] : []), ...(f.av ? ['av'] : [])];
          lines.push(`  • ${f.name}  (${f.lanes.join('/')}; ${tags.join(', ')})`);
          if (f.prerequisite) lines.push(`      prerequisite: ${f.prerequisite.flow} through '${f.prerequisite.throughStage}'`);
          for (const [i, s] of f.stages.entries()) {
            const phase = s.phase !== undefined ? `${s.phase}. ` : '— ';
            const stageTags = (s.tags ?? []).length ? `  [${(s.tags ?? []).join(', ')}]` : '';
            const state = ckpt(f, i);
            const mark = state === 'valid' ? '  [checkpoint]' : state === 'stale' ? '  [checkpoint: re-bake]' : '';
            lines.push(`      ${phase}${s.id}  (${s.project})${stageTags}${mark}`);
          }
        }
      } catch (err) {
        spas.push({ id: spaId, available: false, reason: (err as Error).message });
        lines.push(`${spaId}  — not authored yet (${(err as Error).message.split('.')[0]})`);
      }
    }

    this.emit(flags, { spas }, lines);
  }
}
