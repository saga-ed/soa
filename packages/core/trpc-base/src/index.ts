import { initTRPC } from '@trpc/server';

export function createTRPCBase<TContext extends object>() {
    const t = initTRPC.context<TContext>().create();
    return {
        router: t.router,
        publicProcedure: t.procedure,
        middleware: t.middleware,
        mergeRouters: t.mergeRouters,
        createCallerFactory: t.createCallerFactory,
    };
}

export { initTRPC };
