import { initTRPC, TRPCError } from '@trpc/server';
import type { DatadogSnapshot } from '../../../web/vishnu/src/lib/graph/datadog';
import { cloudMesh } from './cloud-mesh.js';
export interface TelemetryService {
  datadog(): Promise<DatadogSnapshot>;
  eventStats(): Promise<unknown>;
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
    mesh: staffProcedure.query(async ({ ctx }) => cloudMesh(await ctx.telemetry.datadog())),
    datadog: staffProcedure.query(({ ctx }) => ctx.telemetry.datadog()),
    eventStats: staffProcedure.query(({ ctx }) => ctx.telemetry.eventStats()),
  }),
});
export type AppRouter = typeof appRouter;
