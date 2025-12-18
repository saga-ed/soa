import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@saga-ed/soa-api-core/abstract-trpc-controller';
import type { ILogger } from '@saga-ed/soa-logger';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  GetProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type GetProjectInput,
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
      getProjectById: t.input(GetProjectSchema).query(({ input }: { input: GetProjectInput }) => {
        const project = this.projectHelper.getProjectById(input.id);
        if (!project) {
          throw new Error('Project not found');
        }
        return project;
      }),

      // Create project
      createProject: t
        .input(CreateProjectSchema)
        .mutation(({ input }: { input: CreateProjectInput }) => {
          return this.projectHelper.createProject(input);
        }),

      // Update project
      updateProject: t
        .input(UpdateProjectSchema)
        .mutation(({ input }: { input: UpdateProjectInput }) => {
          const updatedProject = this.projectHelper.updateProject(input);
          if (!updatedProject) {
            throw new Error('Project not found');
          }
          return updatedProject;
        }),

      // Delete project
      deleteProject: t.input(GetProjectSchema).mutation(({ input }: { input: GetProjectInput }) => {
        const success = this.projectHelper.deleteProject(input.id);
        if (!success) {
          throw new Error('Project not found');
        }
        return { success: true, message: 'Project deleted successfully' };
      }),
    });
  }
}
