// Channel configuration interface for pubsub channels
export interface ChannelConfig {
    name: string;
    family?: string; // optional grouping of channels
    authScope?: string | ((ctx: any) => boolean | Promise<boolean>);
    historyRetentionMs?: number; // history TTL for late subscribers
    ordered?: boolean; // whether ordering is guaranteed
    maxSubscribers?: number; // limit concurrent subscribers
    maxEventSize?: number; // max payload size in bytes
}
