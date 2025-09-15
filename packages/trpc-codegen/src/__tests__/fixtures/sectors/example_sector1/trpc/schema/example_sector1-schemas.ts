import { z } from 'zod';

// Zod schemas for input validation
export const GetItemSchema = z.object({
  id: z.string().min(1, 'Item ID is required'),
});

export const CreateItemSchema = z.object({
  name: z.string().min(1, 'Item name is required'),
  description: z.string().optional(),
  type: z.enum(['typeA', 'typeB', 'typeC']).default('typeA'),
});

export const UpdateItemSchema = z.object({
  id: z.string().min(1, 'Item ID is required'),
  name: z.string().min(1, 'Item name is required').optional(),
  description: z.string().optional(),
  type: z.enum(['typeA', 'typeB', 'typeC']).optional(),
});

export const DeleteItemSchema = z.object({
  id: z.string().min(1, 'Item ID is required'),
});

export const ListItemsSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
  type: z.enum(['typeA', 'typeB', 'typeC']).optional(),
});