/**
 * Example usage of the enhanced TRPCPubSubClient with auto-subscription
 * 
 * This example demonstrates:
 * 1. CSE events with responses (automatic subscription)
 * 2. CSE events without responses (fire-and-forget)
 * 3. Type-safe event handling
 */

import { TRPCPubSubClient } from '../src/trpc-pubsub-client.js';
import type { 
    CSEEventWithResponse, 
    SSEEvent, 
    CSEEvent 
} from '@saga-ed/soa-pubsub-core';

// ============================================================================
// Event Definitions
// ============================================================================

// Response event (SSE)
const pongEvent: SSEEvent<{ reply: string; originalMessage: string; timestamp: string }> = {
    name: 'pong:response',
    channel: 'pingpong',
    direction: 'SSE',
    description: 'Pong response event'
};

// CSE event with response
const pingEvent: CSEEventWithResponse<
    { message: string; timestamp: string },
    { reply: string; originalMessage: string; timestamp: string },
    typeof pongEvent
> = {
    name: 'ping:message',
    channel: 'pingpong', 
    direction: 'CSE',
    description: 'Ping event that expects a pong response',
    responseEvent: pongEvent,
    action: {
        requestId: crypto.randomUUID(),
        responseEventType: 'pong:response',
        async act(payload) {
            return {
                reply: `Pong: ${payload.message}`,
                originalMessage: payload.message,
                timestamp: new Date().toISOString()
            };
        }
    }
};

// CSE event without response (fire-and-forget)
const logEvent: CSEEvent<{ message: string; level: string }> = {
    name: 'system:log',
    channel: 'system',
    direction: 'CSE', 
    description: 'System log event',
    action: {
        requestId: crypto.randomUUID(),
        async act(payload) {
            console.log(`[${payload.level}] ${payload.message}`);
        }
    }
};

// ============================================================================
// Usage Examples
// ============================================================================

async function demonstrateAutoSubscription() {
    const client = new TRPCPubSubClient({
        baseUrl: 'http://localhost:5000',
        tRPCPath: '/saga-soa/v1/trpc'
    });

    try {
        // ========================================================================
        // Example 1: CSE Event with Response (Auto-subscription)
        // ========================================================================
        
        console.log('🚀 Sending ping with auto-subscription...');
        
        const { publishResult, subscription, waitForResponse } = await client.publishWithAutoSubscribe(
            pingEvent,
            { 
                message: 'Hello from client!', 
                timestamp: new Date().toISOString() 
            },
            (response) => {
                // This handler is automatically typed to expect PongResponseOutput
                console.log('📨 Received pong response:', {
                    reply: response.payload.reply,
                    originalMessage: response.payload.originalMessage,
                    receivedAt: new Date().toISOString()
                });
            },
            { 
                autoUnsubscribe: true, // Automatically unsubscribe after first response
                timeout: 5000 // Timeout after 5 seconds
            }
        );

        console.log('✅ Ping published successfully:', publishResult.eventId);
        
        // Wait for response (optional)
        if (waitForResponse) {
            try {
                const response = await waitForResponse();
                console.log('🎯 Got response via promise:', response.payload);
            } catch (error) {
                console.error('⏰ Response timeout:', error);
            }
        }

        // ========================================================================
        // Example 2: CSE Event without Response (Fire-and-forget)
        // ========================================================================
        
        console.log('🔥 Sending fire-and-forget log event...');
        
        const logResult = await client.publish(logEvent.name, {
            message: 'User successfully logged in',
            level: 'info'
        });

        console.log('✅ Log event published:', logResult.eventId);
        
        // ========================================================================
        // Example 3: Manual Subscription (Traditional approach)
        // ========================================================================
        
        console.log('👂 Setting up manual subscription...');
        
        const manualSubscription = await client.subscribe('pingpong', (event) => {
            console.log('📡 Manual subscription received:', event);
        });

        // Send a regular ping
        await client.publish('ping:message', {
            message: 'Manual ping',
            timestamp: new Date().toISOString()
        });

        // Clean up manual subscription
        setTimeout(async () => {
            await manualSubscription.unsubscribe();
            console.log('🧹 Manual subscription cleaned up');
        }, 2000);

        // ========================================================================
        // Example 4: Multiple Auto-subscriptions
        // ========================================================================
        
        console.log('🚀🚀 Sending multiple pings with auto-subscription...');
        
        const promises = [];
        for (let i = 0; i < 3; i++) {
            promises.push(
                client.publishWithAutoSubscribe(
                    pingEvent,
                    { 
                        message: `Batch ping ${i + 1}`, 
                        timestamp: new Date().toISOString() 
                    },
                    (response) => {
                        console.log(`📨 Batch response ${i + 1}:`, response.payload.reply);
                    },
                    { autoUnsubscribe: true, timeout: 3000 }
                )
            );
        }

        const batchResults = await Promise.all(promises);
        console.log(`✅ ${batchResults.length} batch pings published successfully`);

        // Wait a bit for responses
        await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
        console.error('❌ Error in demonstration:', error);
    } finally {
        // Clean up
        await client.close();
        console.log('🧹 Client closed and resources cleaned up');
    }
}

// Run the demonstration
demonstrateAutoSubscription().catch(console.error);

// ============================================================================
// Type Safety Demonstration
// ============================================================================

function demonstrateTypeSafety() {
    // The following would cause TypeScript compilation errors:
    
    // ❌ Cannot use publishWithAutoSubscribe with regular CSE event
    // client.publishWithAutoSubscribe(logEvent, payload, handler); // Error!
    
    // ❌ Response handler expects wrong payload type
    // client.publishWithAutoSubscribe(pingEvent, payload, (response) => {
    //     response.payload.nonExistentField; // Error!
    // });
    
    // ✅ Correct usage with proper types
    const client = new TRPCPubSubClient({ baseUrl: 'http://localhost:5000' });
    
    client.publishWithAutoSubscribe(
        pingEvent, // Must be CSEEventWithResponse
        { message: 'test', timestamp: '2023-01-01' }, // Correctly typed payload
        (response) => {
            // response.payload is correctly typed as PongResponseOutput
            console.log(response.payload.reply); // ✅ Type-safe access
            console.log(response.payload.originalMessage); // ✅ Type-safe access
            console.log(response.payload.timestamp); // ✅ Type-safe access
        }
    );
}