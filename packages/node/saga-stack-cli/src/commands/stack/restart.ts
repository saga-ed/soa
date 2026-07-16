/**
 * `saga-stack stack restart` — NATIVE clean bounce of the stack (M9).
 *
 * A faithful port of up.sh's `restart` verb (~2293-2306): a clean bounce with NO data
 * wipe. The native path composes the pieces the CLI already owns —
 *   down  (native kill-by-pidfile — NOT a host-global `pkill`/`fuser`)
 *   → vite-clear (up.sh `nuke_vite` — drop the stale optimized-bundle caches)
 *   → up   (the SAME native bring-up: mesh + prep + launch + M9 auto-pull + AV)
 * — via `StackApi.restart`. Crucially `reset_data` NEVER fires (restart = no wipe).
 *
 * DELIBERATE DIVERGENCE (documented, strictly safer): up.sh's `services_down` also
 * reaps host-global `pkill -f tsup` + `fuser -k <port>`; the native teardown is
 * dir-scoped kill-by-pidfile, so it never crosses a peer slot. The vite cache paths
 * ARE byte-faithful to `nuke_vite` (else the stale-bundle trap returns).
 *
 *   node bin/dev.js stack restart            # native down → vite-clear → up
 */

import { BaseCommand } from '../../base-command.js';
import type { NativeRuntimeFlags } from '../../base-command.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import { manifest } from '../../core/manifest/index.js';
import { makeStackApi } from '../../stack-api.js';
import type { Runtime } from '../../stack-api.js';

export default class StackRestart extends BaseCommand {
  static description =
    'Cleanly bounce the stack NATIVELY (down → clear vite caches → up; no data wipe).';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  // NOTE: restart is SLOT-0 ONLY (not `slotAware`) — up.sh's `restart` verb is hardcoded
  // to slot 0, so a `--slot > 0` is rejected by the central guard. The teardown is still
  // dir-scoped/slot-safe (launcher kill-by-pidfile, never a host-global `pkill`).

  /** Slot claims: a bounce DRIVES the (slot-0) stack — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackRestart);

    // ── NATIVE: down → vite-clear → up over the full non-optional closure. ──
    const profile = deriveInstance({ slot: flags.slot });

    const requested = Object.values(manifest.services)
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const services = computeClosure(manifest, requested, {}).services;

    const api = makeStackApi(manifest, this.buildRuntime(flags, profile));
    const outcome = await api.restart(services);

    // Report the three phases.
    const stopped = outcome.down.stopped.filter((s) => s.stopped).map((s) => s.id);
    // Surface any server that SURVIVED SIGTERM+SIGKILL (an under-kill leak) — it would
    // keep holding its port and let the fresh `up` serve STALE code.
    for (const r of outcome.reaped ?? []) {
      if (r.outcome === 'alive') {
        this.log(
          `⚠ ${r.id} STILL ALIVE after SIGTERM+SIGKILL${r.pid !== undefined ? ` (pid ${r.pid})` : ''} — restart may serve stale code`,
        );
      }
    }
    const up = outcome.up;
    if (up.autoPull) {
      this.log(`sibling sync (ff-only — ${up.autoPull.mode}):`);
      for (const r of up.autoPull.repos) this.log(`  ${r.message}`);
    }
    if (up.av) this.log(up.av.message);
    for (const s of up.skipped) this.log(`⚠ ${s.message}`);

    this.emit(
      flags,
      {
        native: true,
        stopped,
        viteCleared: outcome.vite?.removed ?? [],
        launched: up.launched.map((r) => ({ id: r.id, ok: r.ok, alreadyUp: r.alreadyUp ?? false })),
        mesh: { ok: up.mesh.ok },
        ok: up.ok,
      },
      [
        `restart (native): stopped ${stopped.length} service(s), cleared ${outcome.vite?.removed.length ?? 0} vite cache(s)`,
        `stopped: ${stopped.join(', ') || '(none running)'}`,
        `relaunched: ${up.launched.map((r) => `${r.id}${r.alreadyUp ? ' (already up)' : ''}`).join(', ') || '(none)'}`,
        `mesh: ${up.mesh.units.map((u) => `${u.id}=${u.ok ? 'ready' : 'DOWN'}`).join(', ') || '(none)'}`,
        up.ok ? 'restart: OK' : 'restart: FAILED (a service never became healthy)',
      ],
    );

    if (!up.ok) this.exit(1);
  }

  /** Assemble the in-process native `Runtime` (shared BaseCommand wiring). */
  private buildRuntime(flags: NativeRuntimeFlags, profile: InstanceProfile): Runtime {
    return this.buildNativeRuntime(flags, profile);
  }
}
