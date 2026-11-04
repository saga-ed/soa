import { initTRPC, TRPCError } from '@trpc/server';
import type { DatadogSnapshot } from '../../../web/vishnu/src/lib/graph/datadog';
import { canonicalApmServices, cloudMesh } from './cloud-mesh.js';
import { withResourceSystems } from './telemetry/resource-mesh.js';
import type { ResourceSnapshot } from '../../../web/vishnu/src/lib/graph/assistant';
export interface TelemetryService {
  datadog(): Promise<DatadogSnapshot>;
  eventStats(): Promise<unknown>;
  resources?(): Promise<ResourceSnapshot>;
}
export interface Context { staff: boolean; telemetry: TelemetryService }
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape }) { return { ...shape, message: shape.code === -32603 ? 'Telemetry unavailable' : shape.message, data: { ...shape.data, stack: undefined } }; },
});
const staffProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.staff) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next();
});
export const appRouter = t.router({
  telemetry: t.router({
    mesh: staffProcedure.query(async ({ ctx }) => {
      const [data, resources] = await Promise.all([ctx.telemetry.datadog(), ctx.telemetry.resources?.()]);
      return withResourceSystems(cloudMesh(canonicalApmServices(data)), resources);
    }),
    datadog: staffProcedure.query(async ({ ctx }) =>
      canonicalApmServices(await ctx.telemetry.datadog())
    ),
    eventStats: staffProcedure.query(({ ctx }) => ctx.telemetry.eventStats()),
  }),
});
export type AppRouter = typeof appRouter;
