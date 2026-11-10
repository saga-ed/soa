import type { Channel } from 'amqplib';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import { REPORT_EVENT_TYPE } from './contract.js';
import type { ReportTransport } from './reporter.js';

/** The caller owns an isolated reporting connection; this adapter owns each channel it opens. */
export class RabbitMqReportTransport implements ReportTransport {
  constructor(
    private readonly options: {
      readonly exchange: string;
      readonly createChannel: () => Promise<Channel>;
    }
  ) {}

  async send(envelope: EventEnvelope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const channel = await this.options.createChannel();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing)
        closing = Promise.resolve()
          .then(() => channel.close())
          .catch(() => {});
      return closing;
    };
    const abort = () => {
      void close();
    };
    const onError = () => {
      /* amqplib emits errors as well as rejecting outstanding RPCs */
    };
    channel.on('error', onError);
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      // Exchange belongs to the service publisher, not the telemetry consumer/reporter.
      await channel.checkExchange(this.options.exchange);
      signal.throwIfAborted();
      if (
        !channel.publish(
          this.options.exchange,
          REPORT_EVENT_TYPE,
          Buffer.from(JSON.stringify(envelope)),
          {
            contentType: 'application/json',
            messageId: envelope.eventId,
            persistent: false,
          }
        )
      ) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            channel.removeListener('drain', drained);
            channel.removeListener('error', failed);
            channel.removeListener('close', closed);
            signal.removeEventListener('abort', aborted);
          };
          const drained = () => {
            cleanup();
            resolve();
          };
          const failed = () => {
            cleanup();
            reject(new Error('Reporting channel failed'));
          };
          const closed = () => {
            cleanup();
            reject(new Error('Reporting channel closed'));
          };
          const aborted = () => {
            cleanup();
            reject(new Error('Reporting aborted'));
          };
          channel.once('drain', drained);
          channel.once('error', failed);
          channel.once('close', closed);
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await close();
      channel.removeListener('error', onError);
    }
  }
}
