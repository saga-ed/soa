import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  GetProjectSchema,
  CreateRunSchema,
  UpdateRunSchema,
  GetRunSchema,
  GetRunsByProjectSchema,
  type Project,
  type Run,
} from '../../schemas/index.js';
import { mockProjects, mockRuns, mockProject, mockRun } from './test-data.js';

// Initialize tRPC
const t = initTRPC.create();

// Create the mock server router
export const mockRouter = t.router({
  project: t.router({
    getAllProjects: t.procedure
      .query(async (): Promise<Project[]> => {
        return mockProjects;
      }),

    getProjectById: t.procedure
      .input(GetProjectSchema)
      .query(async ({ input }): Promise<Project> => {
        const project = mockProjects.find(p => p.id === input.id);
        if (!project) {
          throw new Error(`Project with id ${input.id} not found`);
        }
        return project;
      }),

    createProject: t.procedure
      .input(CreateProjectSchema)
      .mutation(async ({ input }): Promise<Project> => {
        const newProject: Project = {
          id: Date.now().toString(),
          name: input.name,
          description: input.description,
          status: input.status,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return newProject;
      }),

    updateProject: t.procedure
      .input(UpdateProjectSchema)
      .mutation(async ({ input }): Promise<Project> => {
        const project = mockProjects.find(p => p.id === input.id);
        if (!project) {
          throw new Error(`Project with id ${input.id} not found`);
        }
        
        return {
          ...project,
          name: input.name ?? project.name,
          description: input.description ?? project.description,
          status: input.status ?? project.status,
          updatedAt: new Date(),
        };
      }),

    deleteProject: t.procedure
      .input(GetProjectSchema)
      .mutation(async ({ input }): Promise<{ success: boolean; message: string }> => {
        const project = mockProjects.find(p => p.id === input.id);
        if (!project) {
          throw new Error(`Project with id ${input.id} not found`);
        }
        
        return {
          success: true,
          message: `Project ${input.id} deleted successfully`,
        };
      }),
  }),

  run: t.router({
    getAllRuns: t.procedure
      .query(async (): Promise<Run[]> => {
        return mockRuns;
      }),

    getRunById: t.procedure
      .input(GetRunSchema)
      .query(async ({ input }): Promise<Run> => {
        const run = mockRuns.find(r => r.id === input.id);
        if (!run) {
          throw new Error(`Run with id ${input.id} not found`);
        }
        return run;
      }),

    createRun: t.procedure
      .input(CreateRunSchema)
      .mutation(async ({ input }): Promise<Run> => {
        const newRun: Run = {
          id: Date.now().toString(),
          projectId: input.projectId,
          name: input.name,
          description: input.description,
          status: input.status,
          config: input.config,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return newRun;
      }),

    updateRun: t.procedure
      .input(UpdateRunSchema)
      .mutation(async ({ input }): Promise<Run> => {
        const run = mockRuns.find(r => r.id === input.id);
        if (!run) {
          throw new Error(`Run with id ${input.id} not found`);
        }
        
        return {
          ...run,
          name: input.name ?? run.name,
          description: input.description ?? run.description,
          status: input.status ?? run.status,
          config: input.config ?? run.config,
          updatedAt: new Date(),
        };
      }),

    deleteRun: t.procedure
      .input(GetRunSchema)
      .mutation(async ({ input }): Promise<{ success: boolean; message: string }> => {
        const run = mockRuns.find(r => r.id === input.id);
        if (!run) {
          throw new Error(`Run with id ${input.id} not found`);
        }
        
        return {
          success: true,
          message: `Run ${input.id} deleted successfully`,
        };
      }),

    getRunsByProject: t.procedure
      .input(GetRunsByProjectSchema)
      .query(async ({ input }): Promise<Run[]> => {
        return mockRuns.filter(r => r.projectId === input.projectId);
      }),
  }),
});

export type MockAppRouter = typeof mockRouter; 