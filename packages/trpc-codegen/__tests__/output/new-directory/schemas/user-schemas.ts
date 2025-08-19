import { z } from 'zod';

// Zod schemas for input validation
export const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['admin', 'user', 'guest']).default('user'),
});

export const UpdateUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(['admin', 'user', 'guest']).optional(),
});

export const GetUserSchema = z.object({
  id: z.string().min(1),
});

export const DeleteUserSchema = z.object({
  id: z.string().min(1),
});

export const ListUsersSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
  role: z.enum(['admin', 'user', 'guest']).optional(),
});
