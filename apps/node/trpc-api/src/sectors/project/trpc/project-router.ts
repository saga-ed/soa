import { router, publicProcedure } from '../../../trpc.js';
import {
    CreateProjectSchema,
    UpdateProjectSchema,
    GetProjectSchema,
} from './schema/project-schemas.js';

export const projectRouter = router({
    // Get all projects
    getAllProjects: publicProcedure.query(({ ctx }) => {
        return ctx.projectHelper.getAllProjects();
    }),

    // Get project by ID
    getProjectById: publicProcedure
        .input(GetProjectSchema)
        .query(({ ctx, input }) => {
            const project = ctx.projectHelper.getProjectById(input.id);
            if (!project) {
                throw new Error('Project not found');
            }
            return project;
        }),

    // Create project
    createProject: publicProcedure
        .input(CreateProjectSchema)
        .mutation(({ ctx, input }) => {
            return ctx.projectHelper.createProject(input);
        }),

    // Update project
    updateProject: publicProcedure
        .input(UpdateProjectSchema)
        .mutation(({ ctx, input }) => {
            const updatedProject = ctx.projectHelper.updateProject(input);
            if (!updatedProject) {
                throw new Error('Project not found');
            }
            return updatedProject;
        }),

    // Delete project
    deleteProject: publicProcedure
        .input(GetProjectSchema)
        .mutation(({ ctx, input }) => {
            const success = ctx.projectHelper.deleteProject(input.id);
            if (!success) {
                throw new Error('Project not found');
            }
            return { success: true, message: 'Project deleted successfully' };
        }),
});
