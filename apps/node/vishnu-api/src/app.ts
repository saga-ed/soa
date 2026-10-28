import 'reflect-metadata';
import { Container } from 'inversify';
import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core';
import { PinoLogger, type ILogger, type PinoLoggerConfig } from '@saga-ed/soa-logger';
import { buildIdentity, mountReadinessRoutes } from '@saga-ed/soa-health';
import { createVerifier, readJanusCookie, type Verifier } from '@saga-ed/janus-client/server';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter, type TelemetryService } from './app-router.js';
import type { Config } from './config.js';

export async function createApp(config: Config, telemetry: TelemetryService, options: {
  verifier?: Verifier; staticDir: string; ready?: () => Promise<boolean>; isDraining?: () => boolean;
}) {
  await access(resolve(options.staticDir, 'index.html'));
  const container = new Container();
  const loggerConfig: PinoLoggerConfig = { configType: 'PINO_LOGGER', level: 'info', isExpressContext: true, prettyPrint: false, logFormat: 'json' };
  const serverConfig: ExpressServerConfig = { configType: 'EXPRESS_SERVER', port: config.port, logLevel: 'info', name: 'Vishnu API', basePath: '/api/v1', corsAllowedDomains: [new URL(config.origin).hostname], jsonBodyLimit: '16kb' };
  container.bind('PinoLoggerConfig').toConstantValue(loggerConfig);
  container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();
  container.bind('ExpressServerConfig').toConstantValue(serverConfig);
  container.bind(ExpressServer).toSelf().inSingletonScope();
  container.bind<TelemetryService>('TelemetryService').toConstantValue(telemetry);
  const server = container.get(ExpressServer);
  const app = server.getApp();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' });
    next();
  });
  app.get('/health', (_req, res) => res.status(options.isDraining?.() ? 503 : 200).json({
    status: options.isDraining?.() ? 'draining' : 'ok', service: 'vishnu-api', ...buildIdentity(),
  }));
  mountReadinessRoutes(app, { probes: { runtime: async () => ({ ready: await (options.ready?.() ?? Promise.resolve(true)), detail: 'runtime' }) }, isDraining: options.isDraining });
  const login = new URL('/callback', config.gateUrl);
  // A fixed return URL cannot be changed through Host, Forwarded, Referer or query input.
  login.searchParams.set('next', config.origin + '/');
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).set('Allow', 'GET, HEAD').json({ error: 'Read-only service' }); return; }
    if (req.headers.host !== new URL(config.origin).host || (req.headers.origin && req.headers.origin !== config.origin)) {
      res.status(403).json({ error: 'Origin not allowed' }); return;
    }
    next();
  });
  app.get('/auth/login', (_req, res) => res.redirect(302, login.href));
  const verifier = options.verifier ?? createVerifier({ jwksUrl: config.jwksUrl });
  app.use(async (req, res, next) => {
    try {
      const token = readJanusCookie(req.headers.cookie);
      const result = token ? await verifier.verify(token) : null;
      if (!result?.ok) {
        if (req.path === '/' || req.path.endsWith('.html')) { res.redirect(302, login.href); return; }
        res.status(401).set('WWW-Authenticate', `SagaAuth realm="janus", login="${config.origin}/auth/login"`).json({ error: 'Staff sign-in required' }); return;
      }
      if (!result.claims.permissions.some(p => config.permissions.includes(p))) {
        res.status(403).json({ error: 'Saga staff access required' }); return;
      }
      res.locals.staff = true;
      next();
    } catch { res.status(503).json({ error: 'Authentication unavailable' }); }
  });
  // Match the SOA tRPC apps: health precedes the perimeter; framework routes follow it.
  await server.init(container, []);
  const createContext = (staff: boolean) => ({ staff, telemetry: container.get<TelemetryService>('TelemetryService') });
  app.use('/trpc', createExpressMiddleware({ router: appRouter, createContext: ({ res }) => createContext(res.locals.staff === true) }));
  app.get('/config.json', (_req, res) => res.json({ mode: 'live', apiUrl: '/api/mesh', pollIntervalMs: 15000, environment: config.environment, mqEnabled: config.mqEnabled, mqDeployment: config.mqDeployment, datadogScope: config.datadogScope, transport: 'trpc' }));
  // Compatibility endpoints share the same protected procedures as typed clients.
  const reads = { '/api/mesh': 'mesh', '/api/datadog': 'datadog', '/api/event-stats': 'eventStats' } as const;
  for (const [path, procedure] of Object.entries(reads)) app.get(path, async (req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ error: 'Query targets are not supported' }); return; }
    try { res.json(await appRouter.createCaller(createContext(res.locals.staff === true)).telemetry[procedure]()); }
    catch { res.status(503).json({ error: 'Telemetry unavailable' }); }
  });
  app.use(express.static(resolve(options.staticDir), { dotfiles: 'deny', index: 'index.html', redirect: false, cacheControl: false }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(500).json({ error: 'Request failed' }); };
  app.use(errors);
  return { app, server, container };
}
