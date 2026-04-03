import { router, publicProcedure } from '../../../trpc.js';
import {
    CreateRunSchema,
    UpdateRunSchema,
    GetRunSchema,
} from './schema/run-schemas.js';

export const runRouter = router({
    // Get all runs
    getAllRuns: publicProcedure.query(({ ctx }) => {
        return ctx.runHelper.getAllRuns();
    }),

    // Get run by ID
    getRunById: publicProcedure
        .input(GetRunSchema)
        .query(({ ctx, input }) => {
            const run = ctx.runHelper.getRunById(input.id);
            if (!run) {
                throw new Error('Run not found');
            }
            return run;
        }),

    // Create run
    createRun: publicProcedure
        .input(CreateRunSchema)
        .mutation(({ ctx, input }) => {
            return ctx.runHelper.createRun(input);
        }),

    // Update run
    updateRun: publicProcedure
        .input(UpdateRunSchema)
        .mutation(({ ctx, input }) => {
            const updatedRun = ctx.runHelper.updateRun(input);
            if (!updatedRun) {
                throw new Error('Run not found');
            }
            return updatedRun;
        }),

    // Delete run
    deleteRun: publicProcedure
        .input(GetRunSchema)
        .mutation(({ ctx, input }) => {
            const success = ctx.runHelper.deleteRun(input.id);
            if (!success) {
                throw new Error('Run not found');
            }
            return { success: true, message: 'Run deleted successfully' };
        }),
});
