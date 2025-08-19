import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { container } from '../inversify.config.js';
import { TYPES } from '../types/index.js';
import type { 
  PubSubServerOptions, 
  IPubSubServer,
  ServerCtx,
  SendEventInput,
  SubscribeInput,
  FetchHistoryInput,
  Logger
} from '../types/index.js';
import type { PubSubService } from '../services/index.js';
import type { PubSubAdapter } from '../adapters/base-adapter.js';

export class PubSubServer implements IPubSubServer {
  public router: any;
  private pubSubService: PubSubService;
  private logger: Logger;
  private adapter: PubSubAdapter;
  private events: Record<string, any>;
  private channels: any[];

  constructor(options: PubSubServerOptions) {
    this.adapter = options.adapter;
    this.events = options.events;
    this.channels = options.channels || [];

    // Bind external dependencies to container
    container.bind<PubSubAdapter>(TYPES.PubSubAdapter).toConstantValue(this.adapter);
    
    // Get logger from options or use a default
    if (options.auth) {
      // This would need to be properly integrated with the auth system
      // For now, we'll create a basic logger
      this.logger = {
        info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta),
        error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta),
        warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta),
        debug: (msg: string, meta?: any) => console.log(`[DEBUG] ${msg}`, meta)
      };
    } else {
      this.logger = {
        info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta),
        error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta),
        warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta),
        debug: (msg: string, meta?: any) => console.log(`[DEBUG] ${msg}`, meta)
      };
    }

    container.bind<Logger>(TYPES.Logger).toConstantValue(this.logger);

    // Get services from container
    this.pubSubService = container.get<PubSubService>(TYPES.PubSubService);

    // Register events and channels
    this.pubSubService.registerEvents(this.events);
    if (this.channels.length > 0) {
      const channelService = container.get(TYPES.ChannelService);
      (channelService as any).registerChannels(this.channels);
    }

    // Create tRPC router
    this.router = this.createTRPCRouter(options.router);
  }

  private createTRPCRouter(baseRouter: any) {
    const t = initTRPC.context<ServerCtx>().create();

    // Create pubsub procedures
    const pubsubRouter = t.router({
      sendEvent: t.procedure
        .input(z.object({
          name: z.string(),
          payload: z.any(),
          clientEventId: z.string().optional(),
          correlationId: z.string().optional()
        }))
        .mutation(async ({ input, ctx }) => {
          // Ensure the input matches SendEventInput type
          const sendEventInput: SendEventInput = {
            name: input.name,
            payload: input.payload,
            clientEventId: input.clientEventId,
            correlationId: input.correlationId
          };
          return this.pubSubService.sendEvent(sendEventInput, ctx);
        }),

      subscribe: t.procedure
        .input(z.object({
          channel: z.string(),
          filters: z.record(z.string(), z.any()).optional(),
          cursor: z.string().optional()
        }))
        .subscription(({ input, ctx }) => {
          return observable<any>((emit) => {
            let unsubscribe: (() => Promise<void>) | null = null;

            // Set up subscription
            this.pubSubService.subscribe(input.channel, async (event) => {
              // Apply filters if provided
              if (input.filters) {
                const shouldEmit = Object.entries(input.filters).every(([key, value]) => {
                  if (key === 'name' && event.name !== value) return false;
                  if (key === 'type' && event.meta?.type !== value) return false;
                  return true;
                });

                if (!shouldEmit) return;
              }

              emit.next(event);
            }, ctx).then((sub) => {
              unsubscribe = sub.unsubscribe;
            }).catch((error) => {
              emit.error(error);
            });

            // Return cleanup function
            return () => {
              if (unsubscribe) {
                unsubscribe();
              }
            };
          });
        }),

      fetchHistory: t.procedure
        .input(z.object({
          channel: z.string(),
          since: z.string().optional(),
          limit: z.number().optional()
        }))
        .query(async ({ input, ctx }) => {
          return this.pubSubService.fetchHistory(input.channel, {
            since: input.since,
            limit: input.limit
          }, ctx);
        }),

      health: t.procedure
        .query(async () => {
          return this.pubSubService.health();
        })
    });

    // Merge with base router
    return t.mergeRouters(baseRouter, pubsubRouter);
  }

  getRouter() {
    return this.router;
  }

  async createSSEHandler(req: any, res: any): Promise<void> {
    const { channel } = req.query;
    
    if (!channel || typeof channel !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Channel parameter required' }));
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Create a keep-alive interval
    const keepAlive = setInterval(() => {
      res.write(':\n\n'); // Comment line to keep connection alive
    }, 30000);

    try {
      // Subscribe to the channel
      const { unsubscribe } = await this.pubSubService.subscribe(
        channel,
        async (event) => {
          const data = JSON.stringify(event);
          res.write(`id: ${event.id}\n`);
          res.write(`event: ${event.name}\n`);
          res.write(`data: ${data}\n\n`);
        },
        { user: undefined, services: {} } as ServerCtx // Basic context for SSE
      );

      // Handle client disconnect
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
        this.logger.info('SSE connection closed', { channel });
      });

      // Handle errors
      req.on('error', (error: Error) => {
        clearInterval(keepAlive);
        unsubscribe();
        this.logger.error('SSE connection error', { channel, error: error.message });
      });

    } catch (error) {
      clearInterval(keepAlive);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Subscription failed' 
      }));
    }
  }

  async shutdown(): Promise<void> {
    await this.pubSubService.shutdown();
  }
}

export function createPubSubServer(options: PubSubServerOptions): PubSubServer {
  return new PubSubServer(options);
} 
