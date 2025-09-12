import { initTRPC } from '@trpc/server';
import { z } from 'zod';

// Mock schemas for testing
export const GetProjectSchema = z.object({
  id: z.string()
});

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active')
});

export const UpdateProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional()
});

export const DeleteProjectSchema = z.object({
  id: z.string()
});

// Mock tRPC setup for testing
const t = initTRPC.create();

// Mock router for testing - this simulates the actual router pattern
export const projectRouter = t.router({
  getProject: t.procedure
    .input(GetProjectSchema)
    .query(() => ({ id: '1', name: 'Test Project' })),
  
  createProject: t.procedure
    .input(CreateProjectSchema)
    .mutation(() => ({ id: '1', name: 'New Project' })),
  
  updateProject: t.procedure
    .input(UpdateProjectSchema)
    .mutation(() => ({ id: '1', name: 'Updated Project' })),
  
  deleteProject: t.procedure
    .input(DeleteProjectSchema)
    .mutation(() => ({ success: true })),
  
  listProjects: t.procedure
    .query(() => [{ id: '1', name: 'Project 1' }, { id: '2', name: 'Project 2' }])
});
