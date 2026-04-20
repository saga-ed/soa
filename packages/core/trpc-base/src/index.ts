import { initTRPC, type AnyTRPCRootTypes } from '@trpc/server';
import type { DataTransformerOptions } from '@trpc/server/unstable-core-do-not-import';

export interface CreateTRPCBaseOptions {
    /**
     * Optional data transformer (e.g., superjson) to preserve non-JSON-serializable
     * values like Date, Map, Set, bigint across the wire.
     *
     * When set, both server and client must share the same transformer.
     */
    transformer?: DataTransformerOptions;
}

export function createTRPCBase<TContext extends object>(options?: CreateTRPCBaseOptions) {
    const builder = initTRPC.context<TContext>();
    const t = options?.transformer
        ? builder.create({ transformer: options.transformer })
        : builder.create();
    return {
        router: t.router,
        publicProcedure: t.procedure,
        middleware: t.middleware,
        mergeRouters: t.mergeRouters,
        createCallerFactory: t.createCallerFactory,
    };
}

export { initTRPC };
export type { AnyTRPCRootTypes };
