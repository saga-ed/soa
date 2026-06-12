import { describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts } from '../relay.js';

/**
 * gh-186: the relay holds one transaction open across the publish loop, so its
 * connection sits idle-in-transaction during broker I/O. A pool-level
 * idle_in_transaction_session_timeout (soa-postgres >=0.1.3 defaults it ON at
 * 30s) would terminate the relay mid-batch. drainBatch issues
 * `SET LOCAL idle_in_transaction_session_timeout` right after BEGIN to exempt
 * its own transaction. These tests pin that behavior (0-row path — no broker).
 */
function makeRelay(opts: Partial<OutboxRelayOpts> = {}) {
	const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
	const pool = { connect: vi.fn().mockResolvedValue(client) };
	const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
	const relay = new OutboxRelay({
		pool: pool as unknown as OutboxRelayOpts['pool'],
		connectionManager: {} as unknown as OutboxRelayOpts['connectionManager'],
		exchange: 'test.events',
		logger: logger as unknown as OutboxRelayOpts['logger'],
		...opts,
	});
	// Mark "started" — the 0-row path commits before touching the channel.
	(relay as unknown as { channel: object }).channel = {};
	return { relay, client };
}

const drain = (relay: OutboxRelay) =>
	(relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();

describe('OutboxRelay idle-in-transaction exemption (gh-186)', () => {
	it('SET LOCALs idle_in_transaction_session_timeout (default 300000) right after BEGIN', async () => {
		const { relay, client } = makeRelay();
		await drain(relay);
		const calls = client.query.mock.calls.map((c) => String(c[0]));
		expect(calls[0]).toBe('BEGIN');
		expect(calls[1]).toBe('SET LOCAL idle_in_transaction_session_timeout = 300000');
	});

	it('honors a configured txIdleTimeoutMs (0 disables the timeout for the relay tx)', async () => {
		const { relay, client } = makeRelay({ txIdleTimeoutMs: 0 });
		await drain(relay);
		expect(client.query).toHaveBeenCalledWith(
			'SET LOCAL idle_in_transaction_session_timeout = 0',
		);
	});
});
