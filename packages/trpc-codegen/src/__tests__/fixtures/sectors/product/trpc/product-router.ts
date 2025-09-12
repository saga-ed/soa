import { initTRPC } from '@trpc/server';
import { z } from 'zod';

// Mock schemas for testing
export const GetProductSchema = z.object({
  id: z.string()
});

export const CreateProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  category: z.enum(['electronics', 'clothing', 'books']).default('electronics')
});

export const UpdateProductSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.number().positive().optional(),
  category: z.enum(['electronics', 'clothing', 'books']).optional()
});

export const DeleteProductSchema = z.object({
  id: z.string()
});

export const SearchProductsSchema = z.object({
  query: z.string().min(1),
  category: z.enum(['electronics', 'clothing', 'books']).optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  limit: z.number().min(1).max(100).default(20)
});

// Mock tRPC setup for testing
const t = initTRPC.create();

// Mock router for testing - this simulates the actual router pattern
export const productRouter = t.router({
  getProduct: t.procedure
    .input(GetProductSchema)
    .query(() => ({ id: '1', name: 'Test Product', price: 99.99 })),
  
  createProduct: t.procedure
    .input(CreateProductSchema)
    .mutation(() => ({ id: '1', name: 'New Product', price: 49.99 })),
  
  updateProduct: t.procedure
    .input(UpdateProductSchema)
    .mutation(() => ({ id: '1', name: 'Updated Product', price: 79.99 })),
  
  deleteProduct: t.procedure
    .input(DeleteProductSchema)
    .mutation(() => ({ success: true })),
  
  searchProducts: t.procedure
    .input(SearchProductsSchema)
    .query(() => [{ id: '1', name: 'Product 1' }, { id: '2', name: 'Product 2' }])
});

// Mock controller class for testing
export class ProductController {
  readonly sectorName = 'product';
  
  createRouter() {
    return productRouter;
  }
}
