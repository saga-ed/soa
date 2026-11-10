import { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import { expect, it, vi } from 'vitest';
import { IsolatedRabbitMqReportTransport } from '../service.js';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
vi.mock('amqplib', () => ({ connect: vi.fn() }));

it('destroys the owned socket when a successful publish has a hung connection-close handshake', async () => {
  const channel = Object.assign(new EventEmitter(), {
    checkExchange: vi.fn(async () => {}),
    publish: vi.fn(() => true),
    close: vi.fn(async () => {}),
  });
  const connection = Object.assign(new EventEmitter(), {
    createChannel: vi.fn(async () => channel),
    close: vi.fn(() => new Promise<void>(() => {})),
  });
  vi.mocked(connect).mockResolvedValue(
    connection as unknown as Awaited<ReturnType<typeof connect>>
  );
  const signal = new AbortController().signal;
  const transport = new IsolatedRabbitMqReportTransport('amqp://local', 'test.events');
  await transport.send({ eventId: 'test' } as EventEnvelope, signal);
  expect(connection.close).toHaveBeenCalledOnce();
  const socketOptions = vi.mocked(connect).mock.calls[0]?.[1] as { signal: AbortSignal };
  expect(socketOptions.signal.aborted).toBe(true);
  expect(signal.aborted).toBe(false);
});
