import { z } from 'zod';

// Zod schemas for input validation
export const GetResourceSchema = z.object({
  id: z.string().min(1, 'Resource ID is required'),
});

export const CreateResourceSchema = z.object({
  title: z.string().min(1, 'Resource title is required'),
  content: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});

export const UpdateResourceSchema = z.object({
  id: z.string().min(1, 'Resource ID is required'),
  title: z.string().min(1, 'Resource title is required').optional(),
  content: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

export const DeleteResourceSchema = z.object({
  id: z.string().min(1, 'Resource ID is required'),
});

export const SearchResourcesSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  limit: z.number().min(1).max(50).default(20),
});