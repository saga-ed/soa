import { initTRPC } from '@trpc/server';
import { z } from 'zod';

// Mock schemas for testing
export const GetResourceSchema = z.object({
  id: z.string()
});

export const CreateResourceSchema = z.object({
  title: z.string().min(1),
  content: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft')
});

export const UpdateResourceSchema = z.object({
  id: z.string(),
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional()
});

export const DeleteResourceSchema = z.object({
  id: z.string()
});

export const SearchResourcesSchema = z.object({
  query: z.string().min(1),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  limit: z.number().min(1).max(50).default(20)
});

// Mock tRPC setup for testing
const t = initTRPC.create();

// Mock router for testing - this simulates the actual router pattern
export const exampleSector2Router = t.router({
  getResource: t.procedure
    .input(GetResourceSchema)
    .query(() => ({ id: '1', title: 'Test Resource', status: 'published' })),

  createResource: t.procedure
    .input(CreateResourceSchema)
    .mutation(() => ({ id: '1', title: 'New Resource', status: 'draft' })),

  updateResource: t.procedure
    .input(UpdateResourceSchema)
    .mutation(() => ({ id: '1', title: 'Updated Resource', status: 'published' })),

  deleteResource: t.procedure
    .input(DeleteResourceSchema)
    .mutation(() => ({ success: true })),

  searchResources: t.procedure
    .input(SearchResourcesSchema)
    .query(() => [{ id: '1', title: 'Resource 1' }, { id: '2', title: 'Resource 2' }])
});

// Mock controller class for testing
export class ExampleSector2Controller {
  readonly sectorName = 'example_sector2';

  createRouter() {
    return exampleSector2Router;
  }
}