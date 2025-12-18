import { initTRPC } from '@trpc/server';
import { z } from 'zod';

// Mock schemas for testing
export const GetItemSchema = z.object({
  id: z.string()
});

export const CreateItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['typeA', 'typeB', 'typeC']).default('typeA')
});

export const UpdateItemSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(['typeA', 'typeB', 'typeC']).optional()
});

export const DeleteItemSchema = z.object({
  id: z.string()
});

export const ListItemsSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
  type: z.enum(['typeA', 'typeB', 'typeC']).optional()
});

// Mock tRPC setup for testing
const t = initTRPC.create();

// Mock router for testing - this simulates the actual router pattern
export const exampleSector1Router = t.router({
  getItem: t.procedure
    .input(GetItemSchema)
    .query(() => ({ id: '1', name: 'Test Item', type: 'typeA' })),

  createItem: t.procedure
    .input(CreateItemSchema)
    .mutation(() => ({ id: '1', name: 'New Item', type: 'typeA' })),

  updateItem: t.procedure
    .input(UpdateItemSchema)
    .mutation(() => ({ id: '1', name: 'Updated Item', type: 'typeA' })),

  deleteItem: t.procedure
    .input(DeleteItemSchema)
    .mutation(() => ({ success: true })),

  listItems: t.procedure
    .input(ListItemsSchema)
    .query(() => [{ id: '1', name: 'Item 1' }, { id: '2', name: 'Item 2' }]),

  // Endpoint without input schema for testing
  healthCheck: t.procedure
    .query(() => ({ status: 'ok', timestamp: Date.now() }))
});

// Mock controller class for testing
export class ExampleSector1Controller {
  readonly sectorName = 'example_sector1';

  createRouter() {
    return exampleSector1Router;
  }
}