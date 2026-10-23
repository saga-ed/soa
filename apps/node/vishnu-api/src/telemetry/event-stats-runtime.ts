import { Pool } from 'pg';
import { EventStatsStore } from './event-stats-store';
import { EventStatsReceiver } from './event-stats-receiver';

export function createEventStatsRuntime(env = process.env) {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const pool = new Pool({
    connectionString: required('VISHNU_DATABASE_URL'),
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 3000,
    idle_in_transaction_session_timeout: 5000,
  });
  const scope = {
    environment: required('EVENT_STATS_ENVIRONMENT'),
    deployment: required('EVENT_STATS_DEPLOYMENT'),
    broker: required('EVENT_STATS_BROKER'),
    vhost: required('EVENT_STATS_VHOST'),
  };
  const store = new EventStatsStore(pool, scope);
  const receiver = new EventStatsReceiver({
    url: required('RABBITMQ_URL'),
    queue: `vishnu.${scope.deployment}.event-stats.v1`,
    store,
    onError: kind => console.warn(`[vishnu-event-stats] ${kind} unavailable; retrying`),
  });
  let ready: Promise<void> | undefined;
  let closed = false;
  const start = () =>
    (ready ??= store
      .init()
      .then(() => {
        if (!closed) receiver.start();
      })
      .catch(error => {
        ready = undefined;
        throw error;
      }));
  return {
    async read() {
      await start();
      return { ...(await store.read()), receiver: receiver.status() };
    },
    async close() {
      closed = true;
      await receiver.stop();
      await pool.end();
    },
  };
}
