import { createDatadogReader } from './datadog';
import { createEventStatsRuntime } from './event-stats-runtime';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import type { MeshSnapshot } from '../src/lib/graph/types';
import { createAssistant } from '../../../node/vishnu-api/src/assistant/service';
import { assistantHttp } from '../../../node/vishnu-api/src/assistant/http';
import { createResourceReader } from '../../../node/vishnu-api/src/telemetry/resources';

type Collector = () => Promise<MeshSnapshot>;
type CollectorFactory = (options: { slot: number; stateDir?: string }) => Collector;
type Loader = (root: string) => Promise<CollectorFactory>;
const loadCollector: Loader = async root => {
  const entry = pathToFileURL(
    resolve(root, 'packages/node/saga-stack-cli/dist/runtime/mesh-view.js')
  );
  // Vite restarts in the same process; refresh a rebuilt native collector module.
  entry.searchParams.set('build', String((await stat(entry)).mtimeMs));
  const module = await import(/* @vite-ignore */ entry.href);
  return module.createLocalMeshCollector;
};

/** Development-only bridge. No arbitrary targets, shell commands, or mutations. */
export function localMeshMiddleware(
  env: Record<string, string | undefined> = process.env,
  loader: Loader = loadCollector,
  readStats?: () => Promise<unknown>,
  readDatadog = createDatadogReader(env)
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
  const resources = createResourceReader(env);
  const assistant = createAssistant({ mesh: async () => (await getCollector())(), datadog: readDatadog, resources }, env);
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0];
    if (!['/config.json', '/api/mesh', '/api/health', '/api/event-stats', '/api/datadog', '/api/resources', '/api/assistant/status', '/api/assistant/turn'].includes(path ?? '')) return next();
    if (req.method !== (path === '/api/assistant/turn' ? 'POST' : 'GET')) return reply(res, 405, { error: 'Method not allowed' });
    const remote = req.socket.remoteAddress;
    if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return reply(res, 403, { error: 'Local synthetic-dev access only' });
    }
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('host');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
        throw new Error('origin');
      if (path === '/api/assistant/turn' && !req.headers.origin) throw new Error('origin');
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
      if (path === '/api/assistant/status') return reply(res, 200, assistant.status());
      if (path === '/api/assistant/turn') return await assistantHttp(req, res, assistant, 'local-synthetic');
      if (path === '/api/resources') return reply(res, 200, await resources());
      if (path === '/api/datadog') return reply(res, 200, await readDatadog());
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
    async configureServer(server) {
      const env = { ...loadEnv(server.config.mode, server.config.envDir, ''), ...process.env };
      let localPeerPorts: Record<string, string> = {};
      if (env.VISHNU_MODE === 'synthetic') {
        const root = env.VISHNU_SOA_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url));
        const entry = pathToFileURL(resolve(root, 'packages/node/saga-stack-cli/dist/core/derive-instance.js'));
        const { deriveInstance, slotExcludedServices } = await import(/* @vite-ignore */ entry.href);
        const slot = Number(env.VISHNU_SLOT ?? '0');
        const profile = deriveInstance({ slot });
        const excluded = new Set(slotExcludedServices(slot));
        localPeerPorts = Object.fromEntries(Object.entries(profile.portOverrides)
          .filter(([service]) => !excluded.has(service))
          .map(([service, port]) => [String(port), service]));
      }
      const runtime = env.VISHNU_MODE === 'synthetic' ? createEventStatsRuntime(env) : undefined;
      if (runtime) void runtime.read().catch(() => console.warn('[vishnu-event-stats] startup unavailable; API access retries initialization'));
      server.middlewares.use(localMeshMiddleware(env, loadCollector, runtime?.read,
        createDatadogReader(env, fetch, Date.now, localPeerPorts)));
      server.httpServer?.once('close', () => { void runtime?.close(); });
    },
  };
}
