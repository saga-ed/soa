import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@hipponot/soa-api-core/abstract-trpc-controller';
import type { ILogger } from '@hipponot/soa-logger';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  GetProjectSchema,
  type CreateProjectZ,
  type UpdateProjectZ,
  type GetProjectZ,
} from './schema/project-schemas.js';
import { ProjectHelper } from './project-helper.js';

@injectable()
export class ProjectController extends AbstractTRPCController {
  readonly sectorName = 'project';
  private projectHelper: ProjectHelper;

  constructor(@inject('ILogger') logger: ILogger) {
    super(logger);
    this.projectHelper = new ProjectHelper();
  }

  createRouter() {
    const t = this.createProcedure();

    return router({
      // Get all projects
      getAllProjects: t.query(() => {
        return this.projectHelper.getAllProjects();
      }),

      // Get project by ID
      getProjectById: t.input(GetProjectSchema).query(({ input }: { input: GetProjectZ }) => {
        const project = this.projectHelper.getProjectById(input.id);
        if (!project) {
          throw new Error('Project not found');
        }
        return project;
      }),

      // Create project
      createProject: t
        .input(CreateProjectSchema)
        .mutation(({ input }: { input: CreateProjectZ }) => {
          return this.projectHelper.createProject(input);
        }),

      // Update project
      updateProject: t
        .input(UpdateProjectSchema)
        .mutation(({ input }: { input: UpdateProjectZ }) => {
          const updatedProject = this.projectHelper.updateProject(input);
          if (!updatedProject) {
            throw new Error('Project not found');
          }
          return updatedProject;
        }),

      // Delete project
      deleteProject: t.input(GetProjectSchema).mutation(({ input }: { input: GetProjectZ }) => {
        const success = this.projectHelper.deleteProject(input.id);
        if (!success) {
          throw new Error('Project not found');
        }
        return { success: true, message: 'Project deleted successfully' };
      }),
    });
  }
}
