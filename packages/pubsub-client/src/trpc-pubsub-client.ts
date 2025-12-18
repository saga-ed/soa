import type { EventEnvelope, EventName, CSEEventWithResponse, SSEEvent } from '@saga-ed/soa-pubsub-core';
import type { AnyRouter } from '@trpc/server';
import type { CreateTRPCClientOptions } from '@trpc/client';
import { createTRPCClient } from '@trpc/client';
import { z } from 'zod';

// Event handler type for subscriptions
export type EventHandler<T = unknown> = (event: EventEnvelope<EventName, T>) => Promise<void> | void;

// Subscription information
export interface Subscription<T = unknown> {
  id: string;
  channel: string;
  handler: EventHandler<T>;
  unsubscribe: () => Promise<void>;
}

// Client configuration
export interface TRPCPubSubClientConfig {
  baseUrl: string;
  tRPCPath?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

// Event publishing result
export interface PublishResult {
  success: boolean;
  eventId: string;
  emittedEvents?: EventEnvelope[];
  error?: string;
}

// Auto-subscription publishing result
export interface PublishWithAutoSubscribeResult<T = unknown> {
  publishResult: PublishResult;
  subscription: Subscription<T>;
  waitForResponse?: () => Promise<EventEnvelope<EventName, T>>;
}

// Options for publishWithAutoSubscribe
export interface AutoSubscribeOptions {
  timeout?: number; // Auto-unsubscribe after timeout
  autoUnsubscribe?: boolean; // Unsubscribe after first response
}

/**
 * TRPCPubSubClient - Client for pubsub functionality using tRPC
 * 
 * This client provides:
 * - Publishing CSE (Client-Sent Events) via tRPC mutations
 * - Subscribing to SSE (Server-Sent Events) via WebSocket/SSE
 * - Type-safe event handling with proper validation
 */
export class TRPCPubSubClient<TRouter extends AnyRouter = AnyRouter> {
  private tRPCClient: ReturnType<typeof createTRPCClient<TRouter>>;
  private subscriptions = new Map<string, Subscription<unknown>>();
  private config: TRPCPubSubClientConfig;

  constructor(config: TRPCPubSubClientConfig) {
    this.config = config;
    
    // Create tRPC client
    const tRPCConfig: CreateTRPCClientOptions<TRouter> = {
      links: [
        // For now, we'll use HTTP links
        // In the future, this could be WebSocket for real-time subscriptions
      ],
      transformer: undefined, // Use default transformer
    };

    this.tRPCClient = createTRPCClient<TRouter>(tRPCConfig);
  }

  /**
   * Publish a CSE (Client-Sent Event) via tRPC
   * @param eventName - The name of the event to publish
   * @param payload - The event payload
   * @param options - Additional event options
   * @returns Promise<PublishResult> - Result of the publish operation
   */
  async publish<T = unknown>(
    eventName: EventName,
    payload: T
  ): Promise<PublishResult> {
    try {
      // Validate event name
      if (!eventName || typeof eventName !== 'string' || !eventName.includes(':')) {
        return {
          success: false,
          eventId: '',
          error: 'Invalid event name. Must be in format "category:action"'
        };
      }

      // For now, we'll simulate the tRPC call
      // In the actual implementation, this would call the appropriate tRPC endpoint
      const eventId = crypto.randomUUID();
      
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Simulate successful publish
      return {
        success: true,
        eventId,
        emittedEvents: [
          {
            id: eventId,
            name: eventName,
            channel: 'default', // This would come from the event definition
            payload,
            timestamp: new Date().toISOString(),
            meta: {}
          }
        ]
      };
    } catch (error) {
      return {
        success: false,
        eventId: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Subscribe to a channel for SSE (Server-Sent Events)
   * @param channel - The channel to subscribe to
   * @param handler - Event handler function
   * @returns Promise<Subscription> - Subscription object with unsubscribe method
   */
  async subscribe<T = unknown>(
    channel: string,
    handler: EventHandler<T>
  ): Promise<Subscription<T>> {
    const subscriptionId = crypto.randomUUID();
    
    // Create subscription object
    const subscription: Subscription<T> = {
      id: subscriptionId,
      channel,
      handler,
      unsubscribe: async () => {
        this.subscriptions.delete(subscriptionId);
        // In the actual implementation, this would close WebSocket/SSE connection
      }
    };

    // Store subscription with type assertion for compatibility
    this.subscriptions.set(subscriptionId, subscription as Subscription<unknown>);

    // In the actual implementation, this would:
    // 1. Establish WebSocket connection to the server
    // 2. Send subscription request
    // 3. Handle incoming events and call the handler

    return subscription;
  }

  /**
   * Unsubscribe from a specific subscription
   * @param subscriptionId - ID of the subscription to unsubscribe from
   * @returns Promise<boolean> - Whether the unsubscribe was successful
   */
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return false;
    }

    await subscription.unsubscribe();
    return true;
  }

  /**
   * Unsubscribe from all subscriptions
   * @returns Promise<void>
   */
  async unsubscribeAll(): Promise<void> {
    const unsubscribePromises = Array.from(this.subscriptions.values()).map(
      sub => sub.unsubscribe()
    );
    await Promise.all(unsubscribePromises);
  }

  /**
   * Get current subscription count
   * @returns number - Number of active subscriptions
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get subscription information
   * @returns Subscription[] - Array of active subscriptions
   */
  getSubscriptions(): Subscription<unknown>[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Publish a CSE event with automatic subscription to response event
   * @param cseEvent - The CSE event with response definition
   * @param payload - The event payload
   * @param responseHandler - Handler for response events
   * @param options - Auto-subscription options
   * @returns Promise<PublishWithAutoSubscribeResult> - Result with subscription and optional response waiter
   */
  async publishWithAutoSubscribe<TPayload, TResult>(
    cseEvent: CSEEventWithResponse<TPayload, TResult>,
    payload: TPayload,
    responseHandler: EventHandler<TResult>,
    options?: AutoSubscribeOptions
  ): Promise<PublishWithAutoSubscribeResult<TResult>> {
    // Auto-subscribe to the response event before publishing
    const subscription = await this.subscribe(
      cseEvent.responseEvent.channel,
      responseHandler
    );
    
    // Publish the CSE event
    const publishResult = await this.publish(cseEvent.name, payload);
    
    // Optional: Create promise that resolves with first matching response
    const waitForResponse = options?.autoUnsubscribe 
      ? () => this.createResponseWaiter(subscription, options.timeout)
      : undefined;
    
    return { publishResult, subscription, waitForResponse };
  }

  /**
   * Creates a promise that waits for the first response and optionally auto-unsubscribes
   * @param subscription - The subscription to wait on
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise that resolves with the first matching response
   */
  private async createResponseWaiter<T>(
    subscription: Subscription<T>, 
    timeout?: number
  ): Promise<EventEnvelope<EventName, T>> {
    return new Promise((resolve, reject) => {
      const originalHandler = subscription.handler;
      let timeoutId: NodeJS.Timeout | undefined;

      // Wrap the handler to capture the first response
      subscription.handler = (event) => {
        if (timeoutId) clearTimeout(timeoutId);
        subscription.unsubscribe(); // Auto-unsubscribe
        resolve(event);
        return originalHandler(event);
      };

      // Set timeout if specified
      if (timeout) {
        timeoutId = setTimeout(() => {
          subscription.unsubscribe();
          reject(new Error(`Response timeout after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  /**
   * Close the client and clean up resources
   * @returns Promise<void>
   */
  async close(): Promise<void> {
    await this.unsubscribeAll();
    // In the actual implementation, this would close any open connections
  }
}
