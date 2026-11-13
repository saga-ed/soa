// MessageConsumer options against a REAL broker, on a quorum queue with x-delivery-limit + a DLX.
//
//   docker run -d --name soa-rmq-int -p 45672:5672 rabbitmq:3-management
//   RABBITMQ_TEST_CONTAINER=soa-rmq-int pnpm --filter @saga-ed/soa-rabbitmq test:int
//
// RABBITMQ_TEST_URL overrides the broker URL. Without RABBITMQ_TEST_CONTAINER the stop/start test is skipped.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { ConnectionManager } from '../src/connection-manager.js';
import { MessageConsumer } from '../src/consumer.js';

const URL_ = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:45672';
const CONTAINER = process.env.RABBITMQ_TEST_CONTAINER;
const NOOP = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const id = randomUUID().slice(0, 8);
const DLX = `dlx.${id}`;
const DEAD_Q = `dead.${id}`;
const queueArgs = (name: string) => ({
  durable: true,
  arguments: {
    'x-queue-type': 'quorum',
    'x-delivery-limit': 3,
    'x-dead-letter-exchange': DLX,
    'x-dead-letter-routing-key': name,
  },
});

let admin: ChannelModel;
let adminCh: Channel;
const managers: ConnectionManager[] = [];
const queues: string[] = [];

async function newQueue(name: string): Promise<string> {
  const q = `${name}.${id}`;
  queues.push(q);
  await adminCh.assertQueue(q, queueArgs(q));
  await adminCh.bindQueue(DEAD_Q, DLX, q);
  return q;
}

async function newConsumer() {
  const cm = new ConnectionManager(NOOP as never, {
    url: URL_,
    failureMode: 'log-and-continue',
    failFast: false,
    reconnect: { enabled: true, maxRetries: 10, initialDelay: 500, maxDelay: 5_000 },
  } as never);
  managers.push(cm);
  await cm.connect();
  const consumer = new MessageConsumer(cm);
  await consumer.requestChannel('c');
  return { cm, consumer };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for condition');
};

beforeAll(async () => {
  admin = await connect(URL_);
  adminCh = await admin.createChannel();
  // The stop/start test kills this connection; its 'error' events must not fail the suite.
  admin.on('error', () => {});
  adminCh.on('error', () => {});
  await adminCh.assertExchange(DLX, 'direct', { durable: true });
  await adminCh.assertQueue(DEAD_Q, { durable: true });
});

afterAll(async () => {
  for (const cm of managers) await cm.close().catch(() => {});
  const cleanup = await connect(URL_);
  const ch = await cleanup.createChannel();
  for (const q of [...queues, DEAD_Q]) await ch.deleteQueue(q).catch(() => {});
  await ch.deleteExchange(DLX).catch(() => {});
  await cleanup.close();
  await admin.close().catch(() => {});
});

describe('MessageConsumer options against a real broker', () => {
  it('manual ack: the handler acks on the arrival channel and MessageConsumer does not double-ack (no 406)', async () => {
    const q = await newQueue('manual-ack');
    const { consumer } = await newConsumer();
    const got: string[] = [];
    await consumer.consumeFromQueue(
      'c',
      q,
      async (msg: ConsumeMessage, ch: Channel) => {
        got.push(msg.content.toString());
        ch.ack(msg);
      },
      { ackMode: 'manual', queue: { args: queueArgs(q) } },
    );
    adminCh.sendToQueue(q, Buffer.from('one'));
    await until(() => got.length === 1);
    await until(async () => (await adminCh.checkQueue(q)).messageCount === 0);
    // A double-ack would have closed the channel with 406; the consumer must still be live.
    await new Promise((r) => setTimeout(r, 500));
    expect(consumer.isConsuming()).toBe(true);
    adminCh.sendToQueue(q, Buffer.from('two'));
    await until(() => got.length === 2);
  });

  it('manual nack(msg, false, false) dead-letters to the DLX', async () => {
    const q = await newQueue('manual-nack');
    const { consumer } = await newConsumer();
    await consumer.consumeFromQueue(
      'c',
      q,
      async (msg: ConsumeMessage, ch: Channel) => {
        ch.nack(msg, false, false);
      },
      { ackMode: 'manual', queue: { args: queueArgs(q) } },
    );
    adminCh.sendToQueue(q, Buffer.from('poison'));
    let dead: string | undefined;
    await until(async () => {
      const m = await adminCh.get(DEAD_Q, { noAck: true });
      if (m) dead = m.content.toString();
      return !!m;
    });
    expect(dead).toBe('poison');
  });

  it('prefetch is honoured: only N unacked messages are delivered', async () => {
    const q = await newQueue('prefetch');
    const { consumer } = await newConsumer();
    const held: ConsumeMessage[] = [];
    await consumer.consumeFromQueue(
      'c',
      q,
      async (msg: ConsumeMessage) => {
        held.push(msg); // never acks
      },
      { ackMode: 'manual', prefetch: 2, queue: { args: queueArgs(q) } },
    );
    for (let i = 0; i < 5; i++) adminCh.sendToQueue(q, Buffer.from(String(i)));
    await until(() => held.length === 2);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(held.length).toBe(2);
  });

  it("a bare assertQueue on that quorum queue is a 406 (why queue.args exists); passive works", async () => {
    const q = await newQueue('passive');
    const { consumer } = await newConsumer();
    const got: string[] = [];
    await consumer.consumeFromQueue('c', q, async (m: ConsumeMessage, ch: Channel) => {
      got.push(m.content.toString());
      ch.ack(m);
    }, { ackMode: 'manual', queue: { passive: true } });
    adminCh.sendToQueue(q, Buffer.from('p'));
    await until(() => got.length === 1);

    const probe = await admin.createChannel();
    probe.on('error', () => {});
    await expect(probe.assertQueue(q)).rejects.toThrow(/PRECONDITION_FAILED|inequivalent/i);
  });

  it.skipIf(!CONTAINER)(
    'resubscribes after a broker stop/start with queue args: no 406 loop, message consumed',
    async () => {
      const q = await newQueue('restart');
      const { consumer } = await newConsumer();
      const got: string[] = [];
      await consumer.consumeFromQueue(
        'c',
        q,
        async (msg: ConsumeMessage, ch: Channel) => {
          got.push(msg.content.toString());
          ch.ack(msg);
        },
        { ackMode: 'manual', prefetch: 5, queue: { args: queueArgs(q) } },
      );
      adminCh.sendToQueue(q, Buffer.from('before'));
      await until(() => got.length === 1);

      // The admin connection dies with the broker too; reconnect it afterwards.
      execFileSync('docker', ['stop', CONTAINER!]);
      await new Promise((r) => setTimeout(r, 5_000));
      expect(consumer.isConsuming()).toBe(false);
      execFileSync('docker', ['start', CONTAINER!]);

      let publisher: ChannelModel | undefined;
      await until(async () => {
        try {
          publisher = await connect(URL_);
          return true;
        } catch {
          return false;
        }
      }, 90_000);
      const pch = await publisher!.createChannel();
      await until(() => consumer.isConsuming(), 90_000);
      pch.sendToQueue(q, Buffer.from('after'));
      await until(() => got.includes('after'), 30_000);

      // No 406 loop: recovery needed few attempts and left no error behind.
      expect(consumer.state()).toEqual([{ channelName: 'c', status: 'subscribed', attempts: 0 }]);
      await publisher!.close();
    },
    240_000,
  );
});
