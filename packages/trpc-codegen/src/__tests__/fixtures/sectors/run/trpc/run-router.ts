import { initTRPC } from '@trpc/server';
import { z } from 'zod';

// Mock schemas for testing
export const GetRunSchema = z.object({
  id: z.string()
});

export const CreateRunSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).default('pending'),
  config: z.record(z.unknown()).optional()
});

export const UpdateRunSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
  config: z.record(z.unknown()).optional()
});

export const DeleteRunSchema = z.object({
  id: z.string()
});

export const GetRunsByProjectSchema = z.object({
  projectId: z.string().min(1),
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0)
});

// Mock tRPC setup for testing
const t = initTRPC.create();

// Mock router for testing - this simulates the actual router pattern
export const runRouter = t.router({
  getRun: t.procedure
    .input(GetRunSchema)
    .query(() => ({ id: '1', name: 'Test Run', projectId: '1' })),
  
  createRun: t.procedure
    .input(CreateRunSchema)
    .mutation(() => ({ id: '1', name: 'New Run', projectId: '1' })),
  
  updateRun: t.procedure
    .input(UpdateRunSchema)
    .mutation(() => ({ id: '1', name: 'Updated Run', projectId: '1' })),
  
  deleteRun: t.procedure
    .input(DeleteRunSchema)
    .mutation(() => ({ success: true })),
  
  getRunsByProject: t.procedure
    .input(GetRunsByProjectSchema)
    .query(() => [{ id: '1', name: 'Run 1' }, { id: '2', name: 'Run 2' }])
});
