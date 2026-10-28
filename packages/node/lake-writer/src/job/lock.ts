// Session-level advisory lock held on ONE checked-out client for the run's
// duration; pool.query() could unlock a different physical connection.

import type { PgPoolLike } from './pg-like.js';

export type AdvisoryLock = { acquired: true; release(): Promise<void> } | { acquired: false };

/** UTC hour bucket as an int4-safe key. */
export function hourLockKey(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000);
}

export async function tryAcquireAdvisoryLock(
  pool: PgPoolLike,
  key1: number,
  key2: number,
): Promise<AdvisoryLock> {
  const client = await pool.connect();
  let locked: boolean;
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked',
      [key1, key2],
    );
    locked = res.rows[0]?.locked ?? false;
  } catch (err) {
    client.release();
    throw err;
  }
  if (!locked) {
    client.release();
    return { acquired: false };
  }
  return {
    acquired: true,
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [key1, key2]);
      } finally {
        client.release();
      }
    },
  };
}
