import { createTRPCBase } from '@saga-ed/soa-trpc-base';
import type { ILogger } from '@saga-ed/soa-logger';
import type { PubSubService, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { ProjectHelper } from './sectors/project/trpc/project-helper.js';
import type { RunHelper } from './sectors/run/trpc/run-helper.js';

export interface TRPCContext {
    logger: ILogger;
    pubsubService: PubSubService;
    channelService: ChannelService;
    projectHelper: ProjectHelper;
    runHelper: RunHelper;
}

const t = createTRPCBase<TRPCContext>();

export const router = t.router;
export const publicProcedure = t.publicProcedure;
export const createCallerFactory = t.createCallerFactory;
