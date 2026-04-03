import { router } from './trpc.js';
import { projectRouter } from './sectors/project/trpc/project-router.js';
import { runRouter } from './sectors/run/trpc/run-router.js';
import { pubsubRouter } from './sectors/pubsub/trpc/pubsub-router.js';

export const appRouter = router({
    project: projectRouter,
    run: runRouter,
    pubsub: pubsubRouter,
});

export type AppRouter = typeof appRouter;
