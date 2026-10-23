import 'reflect-metadata';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createDatadogReader } from './telemetry/datadog.js';
import { createEventStatsRuntime } from './telemetry/event-stats-runtime.js';

const config = loadConfig(process.env);
const datadog = createDatadogReader(process.env);
const runtime = config.mqEnabled ? createEventStatsRuntime(process.env) : undefined;
let draining = false;
const ready = async () => !runtime || (await runtime.read()).receiver.connected;
const { server } = await createApp(config, {
  datadog,
  eventStats: async () => {
    if (!runtime) throw new Error('MQ telemetry is not enabled');
    return runtime.read();
  },
}, { staticDir: resolve(process.env.VISHNU_STATIC_DIR ?? fileURLToPath(new URL('../../../web/vishnu/build/', import.meta.url))), ready, isDraining: () => draining });
if (runtime) void runtime.read().catch(() => console.warn('[vishnu] MQ startup pending'));
server.start();
const stop = async () => {
  if (draining) return;
  draining = true;
  const timeout = setTimeout(() => process.exit(1), 15000);
  timeout.unref();
  server.stop();
  await runtime?.close();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
