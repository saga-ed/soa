import { EventEmitter } from 'node:events';
import type { Channel } from 'amqplib';
import { expect, it, vi } from 'vitest';
import { buildEnvelope } from '@saga-ed/soa-event-envelope';
import { RabbitMqReportTransport } from '../rabbitmq-transport.js';
const envelope = buildEnvelope({
  eventType: 'observability.event_stats.reported',
  eventVersion: 1,
  aggregateType: 'stats',
  aggregateId: 'test',
  payload: {},
});
function fixture() {
  const channel = Object.assign(new EventEmitter(), {
    checkExchange: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return {
    channel,
    transport: new RabbitMqReportTransport({
      exchange: 'existing.events',
      createChannel: async () => channel as unknown as Channel,
    }),
  };
}
it('closes its own channel and clears backpressure listeners on timeout abort', async () => {
  const { channel, transport } = fixture();
  const controller = new AbortController();
  const sending = transport.send(envelope, controller.signal);
  const rejection = expect(sending).rejects.toThrow('Reporting aborted');
  await vi.waitFor(() => expect(channel.listenerCount('drain')).toBe(1));
  controller.abort();
  await rejection;
  expect(channel.close).toHaveBeenCalledOnce();
  for (const name of ['drain', 'close', 'error']) expect(channel.listenerCount(name)).toBe(0);
});
it('uses the existing publisher exchange and the telemetry routing key', async () => {
  const { channel, transport } = fixture();
  channel.publish.mockReturnValue(true);
  await transport.send(envelope, new AbortController().signal);
  expect(channel.checkExchange).toHaveBeenCalledWith('existing.events');
  expect(channel.publish).toHaveBeenCalledWith(
    'existing.events',
    'observability.event_stats.reported',
    expect.any(Buffer),
    expect.objectContaining({ persistent: false })
  );
  expect(channel.close).toHaveBeenCalledOnce();
});
