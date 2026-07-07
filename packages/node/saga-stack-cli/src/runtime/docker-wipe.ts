/**
 * `docker-wipe` — the destructive docker teardown a COLD START needs (soa#cold-start).
 *
 * The everyday `stack down --mesh` runs `make down` = `docker compose down` (NO `-v`),
 * so the mesh volumes — postgres/mongo/rabbitmq/redis DATA — SURVIVE. That is correct for
 * a fast bounce, but a true clean slate must drop that data so `up --reset` re-provisions +
 * re-migrates + re-seeds from nothing. There is no `-v` teardown target in `infra/Makefile`
 * (`down:` is hardcoded to `$(COMPOSE) down`), so this module drives `docker compose … down
 * -v --remove-orphans` DIRECTLY against the SAME compose file + project the mesh came up under.
 *
 * SCOPE (deliberately narrow, the safe default): only the saga mesh's OWN compose project is
 * torn down + volume-wiped — never a host-global `docker system prune`. The nuclear option
 * (`systemPrune`, ⇒ `docker system prune -af --volumes`, which removes EVERY stopped container,
 * unused network, dangling image, AND unused volume on the box) is a SEPARATE method the
 * command only calls behind an explicit `--all-docker` + a confirm, so a stray keystroke can
 * never wipe an unrelated project's docker state.
 *
 * The compose invocation MIRRORS `infra/Makefile`'s `COMPOSE` var:
 *   docker compose --env-file .env.defaults -f compose/projects/saga-mesh.yml \
 *     -p <project> down -v --remove-orphans          (cwd = <soaRoot>/infra)
 * `-p <project>` is passed EXPLICITLY (unlike the Makefile, which leans on `COMPOSE_PROJECT_NAME
 * ?= soa`) because a bare `docker compose` has no such default — omitting it would target the
 * dir-named project, not `soa`, and silently miss the real containers/volumes.
 *
 * The argv builders are PURE (unit-tested with no docker); IO lives behind the injectable
 * `DockerWipe` seam (`makeRealDockerWipe()` is the only place `docker` is spawned here).
 *
 * INVARIANT (plan hard constraint): docker IO lives only in `src/runtime/**`.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** The compose file the saga mesh comes up from (infra `PROJECT=saga-mesh`). */
export const MESH_COMPOSE_FILE = 'compose/projects/saga-mesh.yml';
/** The env file the infra Makefile's `COMPOSE` var passes (`--env-file .env.defaults`). */
export const MESH_COMPOSE_ENV_FILE = '.env.defaults';

/** A resolved compose target: which project + soa checkout the mesh runs under. */
export interface ComposeTarget {
  /** Absolute path to the soa checkout (the compose runs in `<soaRoot>/infra`). */
  soaRoot: string;
  /** COMPOSE_PROJECT_NAME — `soa` at slot 0, `soa-s<N>` at a slot. Passed as `-p`. */
  project: string;
}

/**
 * The `docker compose … down -v --remove-orphans` argv that stops + removes the mesh
 * containers AND their named volumes (the DATA) AND any orphaned containers left from an
 * older compose topology. Mirrors `infra/Makefile`'s `COMPOSE` var, plus `-p <project>`
 * (see the module header on why it's explicit) and the `-v`/`--remove-orphans` the clean
 * slate needs. Pure — the caller runs it in `<soaRoot>/infra`.
 */
export function composeDownVArgs(project: string): string[] {
  return [
    'compose',
    '--env-file',
    MESH_COMPOSE_ENV_FILE,
    '-f',
    MESH_COMPOSE_FILE,
    '-p',
    project,
    'down',
    '--volumes',
    '--remove-orphans',
  ];
}

/**
 * The `docker system prune -af --volumes` argv — the host-global nuke (`--all-docker`). Removes
 * ALL stopped containers, unused networks, dangling+unreferenced images, the build cache, AND
 * unused volumes across the WHOLE docker host, not just the mesh. Behind an explicit flag +
 * confirm in the command. Pure.
 */
export function systemPruneArgs(): string[] {
  return ['system', 'prune', '--all', '--force', '--volumes'];
}

/** The outcome of one docker invocation. */
export interface DockerWipeResult {
  ok: boolean;
  /** The `docker` exit code (0 ⇒ success). */
  code: number;
}

/**
 * The injectable docker-wipe seam. Two destructive verbs — the scoped compose volume wipe
 * (cold start's default) and the host-global system prune (`--all-docker` only). Production
 * wires `makeRealDockerWipe()` (the only place `docker` is spawned for the wipe); tests pass a
 * fake so the argv + ordering are asserted with no real docker.
 */
export interface DockerWipe {
  /** `docker compose … down -v --remove-orphans` in `<soaRoot>/infra` — mesh containers + volumes. */
  composeDownVolumes(target: ComposeTarget): Promise<DockerWipeResult>;
  /** `docker system prune -af --volumes` — the host-global nuke (`--all-docker`). */
  systemPrune(): Promise<DockerWipeResult>;
}

/** Run `docker …args` (optionally in `cwd`); resolve `{ ok, code }`. NEVER throws. */
function runDocker(args: string[], cwd?: string): Promise<DockerWipeResult> {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { cwd, encoding: 'utf8' }, () => {});
    // stdio inherit-like: surface docker's own progress on the user's TTY.
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on('error', () => resolve({ ok: false, code: 127 }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 1 }));
  });
}

/**
 * The production docker-wipe: each verb is exactly the pure argv above, spawned via `docker`
 * with output streamed to the user's terminal. A missing docker / non-zero exit folds to
 * `{ ok:false, code }` (never throws) so the command renders the failure and decides.
 */
export function makeRealDockerWipe(): DockerWipe {
  return {
    composeDownVolumes(target: ComposeTarget): Promise<DockerWipeResult> {
      return runDocker(composeDownVArgs(target.project), join(target.soaRoot, 'infra'));
    },
    systemPrune(): Promise<DockerWipeResult> {
      return runDocker(systemPruneArgs());
    },
  };
}
