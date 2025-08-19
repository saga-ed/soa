import { z } from 'zod';

// Zod schemas for input validation
export const CreateProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  category: z.enum(['electronics', 'clothing', 'books']).default('electronics'),
});

export const UpdateProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.number().positive().optional(),
  category: z.enum(['electronics', 'clothing', 'books']).optional(),
});

export const GetProductSchema = z.object({
  id: z.string().min(1),
});

export const DeleteProductSchema = z.object({
  id: z.string().min(1),
});

export const SearchProductsSchema = z.object({
  query: z.string().min(1),
  category: z.enum(['electronics', 'clothing', 'books']).optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  limit: z.number().min(1).max(100).default(20),
});
