import { Pool } from 'pg';
import { createChartReader } from './reader';
import { ChartViewStore, ChartError } from './store';
import { Chart, SaveView, resolveWindow } from './schema';
import type { MeshSnapshot } from '../../../../web/vishnu/src/lib/graph/types';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';

export const chartPath = (path: string) =>
  /^\/api\/(charts\/(catalog|query)|chart-views(?:\/[0-9a-f-]{36})?)$/.test(path);
export const chartMethod = (path: string, method: string) =>
  (path === '/api/charts/catalog' && method === 'GET') ||
  (path === '/api/charts/query' && method === 'POST') ||
  (path === '/api/chart-views' && ['GET', 'POST'].includes(method)) ||
  (/^\/api\/chart-views\/[0-9a-f-]{36}$/.test(path) && ['PUT', 'DELETE'].includes(method));
export function createChartRuntime(
  mesh: () => Promise<MeshSnapshot>,
  env: Record<string, string | undefined> = process.env
) {
  const reader = createChartReader(env);
  const pool = env.VISHNU_DATABASE_URL
    ? new Pool({
        connectionString: env.VISHNU_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 2000,
        statement_timeout: 3000,
        idle_in_transaction_session_timeout: 5000,
      })
    : undefined;
  pool?.on('error', () => console.warn('[vishnu-charts] database connection unavailable'));
  const scopeKey = JSON.stringify({
    ...reader.scope,
    deploymentTag: env.VISHNU_DATADOG_DEPLOYMENT_TAG ?? 'deployment.identifier',
    meshDeployment: env.EVENT_STATS_DEPLOYMENT ?? null,
    preview: env.VISHNU_MQ_PREVIEW_TAG ?? null,
  });
  const store = pool ? new ChartViewStore(pool, scopeKey) : undefined;
  async function validate(input: unknown) {
    const spec = Chart.parse(input);
    if (!(await mesh()).systems.some(s => s.id === spec.system))
      throw new ChartError(400, 'System is not in this mesh.');
    return spec;
  }
  const read = async (input: unknown) => {
    const spec = await validate(input);
    try { resolveWindow(spec.time); } catch { throw new ChartError(400, 'Choose 5 minutes to 30 days within the last 31 days.'); }
    return reader.read(spec);
  };
  return {
    read,
    close: async () => {
      await pool?.end();
    },
    async handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse, owner: string) {
      const reply = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(value));
      };
      try {
        const path = req.url?.split('?')[0] ?? '';
        if (req.url?.includes('?')) throw new ChartError(400, 'Query targets are not supported.');
        if (!chartMethod(path, req.method ?? '')) throw new ChartError(405, 'Method not allowed.');
        if (!owner) throw new ChartError(403, 'Staff identity required.');
        if (path === '/api/charts/catalog')
          return reply(200, {
            scope: reader.scope,
            saving: !!store,
            maxCharts: 8,
            maxDays: 30,
            kinds: ['line', 'histogram', 'scatter'],
          });
        let body = req.body;
        if (['POST', 'PUT'].includes(req.method!)) {
          if (!req.headers['content-type']?.startsWith('application/json'))
            throw new ChartError(415, 'JSON required.');
          if (body === undefined) {
            let raw = '';
            for await (const chunk of req) {
              raw += chunk.toString();
              if (Buffer.byteLength(raw) > 16_384) throw new ChartError(413, 'Request too large.');
            }
            try {
              body = JSON.parse(raw);
            } catch {
              throw new ChartError(400, 'Invalid JSON.');
            }
          }
        }
        if (path === '/api/charts/query') return reply(200, await read(body));
        if (!store)
          throw new ChartError(503, 'Saved views require the Vishnu Postgres connection.');
        if (req.method === 'GET') return reply(200, { views: await store.list(owner) });
        const id = path.split('/')[3];
        if (id && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
          throw new ChartError(400, 'Invalid view ID.');
        if (req.method === 'DELETE') {
          await store.remove(owner, id);
          return reply(200, { deleted: true });
        }
        const value = SaveView.parse(body);
        const systems = new Set((await mesh()).systems.map(s => s.id));
        if (value.definition.charts.some(c => !systems.has(c.system)))
          throw new ChartError(400, 'A chart system is no longer in this mesh.');
        return reply(req.method === 'POST' ? 201 : 200, await store.save(owner, value, id));
      } catch (e) {
        if (e instanceof ZodError)
          return reply(400, { error: 'Invalid chart or saved view definition.' });
        if (e instanceof ChartError) return reply(e.status, { error: e.message });
        return reply(503, {
          error:
            'Chart request unavailable. Check the time range, database and Datadog availability.',
        });
      }
    },
  };
}
