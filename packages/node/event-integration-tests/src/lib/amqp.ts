import amqplib, { type ChannelModel } from 'amqplib';

/** Minimal ConnectionManager over a real amqplib connection (what the consumer/relay actually use). */
export function makeConnectionManager(url: string) {
    let conn: ChannelModel | null = null;
    const ensureConnected = async (): Promise<void> => {
        conn ??= await amqplib.connect(url);
    };
    return {
        ensureConnected,
        newChannel: async () => {
            await ensureConnected();
            return conn!.createChannel();
        },
        close: async () => {
            await conn?.close();
            conn = null;
        },
    };
}

/** Controllable ActivityGate for tests. */
export function makeGate(initial: boolean) {
    const listeners: Array<(active: boolean, value: string | undefined) => void> = [];
    let active = initial;
    return {
        gate: {
            isActive: () => active,
            on: (_event: 'change', cb: (active: boolean, value: string | undefined) => void) => {
                listeners.push(cb);
            },
        },
        set(next: boolean) {
            active = next;
            for (const cb of listeners) cb(next, next ? 'blue' : 'green');
        },
    };
}
