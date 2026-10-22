import { createEventStatsRuntime } from './event-stats-runtime';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { MeshSnapshot } from '../src/lib/graph/types';

type Collector = () => Promise<MeshSnapshot>;
type CollectorFactory = (options: { slot: number; stateDir?: string }) => Collector;
type Loader = (root: string) => Promise<CollectorFactory>;
const loadCollector: Loader = async root => {
  const entry = pathToFileURL(
    resolve(root, 'packages/node/saga-stack-cli/dist/runtime/mesh-view.js')
  );
  const module = await import(/* @vite-ignore */ entry.href);
  return module.createLocalMeshCollector;
};

/** Development-only bridge. No arbitrary targets, shell commands, or mutations. */
export function localMeshMiddleware(
  env: Record<string, string | undefined> = process.env,
  loader: Loader = loadCollector,
  readStats?: () => Promise<unknown>
) {
  const enabled = env.VISHNU_MODE === 'synthetic';
  let collector: Promise<Collector> | undefined;
  let pending: Promise<MeshSnapshot> | undefined;
  let cached: { value: MeshSnapshot; at: number } | undefined;
  const slot = Number(env.VISHNU_SLOT ?? '0');
  const getCollector = () => {
    if (!Number.isInteger(slot) || slot < 0 || slot > 9)
      throw new Error('Invalid synthetic-dev slot');
    const root = env.VISHNU_SOA_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url));
    collector ??= loader(root).then(create => create({ slot, stateDir: env.VISHNU_STATE_DIR }));
    return collector;
  };
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(value));
  };
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0];
    if (!['/config.json', '/api/mesh', '/api/health', '/api/event-stats'].includes(path ?? '')) return next();
    if (req.method !== 'GET') return reply(res, 405, { error: 'Read-only endpoint' });
    const remote = req.socket.remoteAddress;
    if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return reply(res, 403, { error: 'Local synthetic-dev access only' });
    }
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('host');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
        throw new Error('origin');
    } catch {
      return reply(res, 403, { error: 'Local origin required' });
    }
    if (req.url?.includes('?'))
      return reply(res, 400, { error: 'Query targets are not supported' });
    if (path === '/config.json') {
      return reply(
        res,
        200,
        enabled ? { mode: 'live', apiUrl: '/api/mesh', pollIntervalMs: 15000 } : { mode: 'fixture' }
      );
    }
    if (!enabled)
      return reply(res, 503, {
        error: 'Start Vishnu with ss --with vishnu to enable synthetic-dev observations',
      });
    try {
      if (path === '/api/event-stats') {
        if (!readStats) return reply(res, 503, { error: 'Event statistics unavailable' });
        return reply(res, 200, await readStats());
      }
      const collect = await getCollector();
      if (path === '/api/health') return reply(res, 200, { ok: true, mode: 'live', slot });
      if (cached && Date.now() - cached.at < 3000) return reply(res, 200, cached.value);
      pending ??= collect()
        .then(value => {
          cached = { value, at: Date.now() };
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
      return reply(res, 200, await pending);
    } catch {
      // Do not return local paths, process environment, or probe internals.
      return reply(res, 503, {
        error:
          'Synthetic-dev collector unavailable; build the local saga-stack-cli and check the Vishnu ss log',
      });
    }
  };
}

export function vishnuLocalPlugin(): Plugin {
  return {
    name: 'vishnu-synthetic-dev',
    apply: 'serve',
    configureServer(server) {
      const runtime = process.env.VISHNU_MODE === 'synthetic' ? createEventStatsRuntime() : undefined;
      if (runtime) void runtime.read().catch(() => console.warn('[vishnu-event-stats] startup unavailable; API access retries initialization'));
      server.middlewares.use(localMeshMiddleware(process.env, loadCollector, runtime?.read));
      server.httpServer?.once('close', () => { void runtime?.close(); });
    },
  };
}
