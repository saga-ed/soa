import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@hipponot/soa-api-core/abstract-trpc-controller';
import type { ILogger } from '@hipponot/soa-logger';
import {
  CreateRunSchema,
  UpdateRunSchema,
  GetRunSchema,
  type CreateRunZ,
  type UpdateRunZ,
  type GetRunZ,
} from './schema/run-schemas.js';
import { RunHelper } from './run-helper.js';

@injectable()
export class RunController extends AbstractTRPCController {
  readonly sectorName = 'run';
  private runHelper: RunHelper;

  constructor(@inject('ILogger') logger: ILogger) {
    super(logger);
    this.runHelper = new RunHelper();
  }

  createRouter() {
    const t = this.createProcedure();

    return router({
      // Get all runs
      getAllRuns: t.query(() => {
        return this.runHelper.getAllRuns();
      }),

      // Get run by ID
      getRunById: t.input(GetRunSchema).query(({ input }: { input: GetRunZ }) => {
        const run = this.runHelper.getRunById(input.id);
        if (!run) {
          throw new Error('Run not found');
        }
        return run;
      }),

      // Create run
      createRun: t.input(CreateRunSchema).mutation(({ input }: { input: CreateRunZ }) => {
        return this.runHelper.createRun(input);
      }),

      // Update run
      updateRun: t.input(UpdateRunSchema).mutation(({ input }: { input: UpdateRunZ }) => {
        const updatedRun = this.runHelper.updateRun(input);
        if (!updatedRun) {
          throw new Error('Run not found');
        }
        return updatedRun;
      }),

      // Delete run
      deleteRun: t.input(GetRunSchema).mutation(({ input }: { input: GetRunZ }) => {
        const success = this.runHelper.deleteRun(input.id);
        if (!success) {
          throw new Error('Run not found');
        }
        return { success: true, message: 'Run deleted successfully' };
      }),
    });
  }
}
