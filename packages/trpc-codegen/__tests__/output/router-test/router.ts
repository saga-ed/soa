// Auto-generated - do not edit
// This file is dynamically generated based on sectors in src/sectors/*/trpc/
import { initTRPC } from '@trpc/server';
import * as productSchemas from './schemas/product-schemas.js';
import * as userSchemas from './schemas/user-schemas.js';

const t = initTRPC.create();

export const staticAppRouter = t.router({
  product: t.router({
    getProduct: t.procedure.input(productSchemas.GetProductSchema).query(() => ({})),
    createProduct: t.procedure.input(productSchemas.CreateProductSchema).mutation(() => ({})),
    updateProduct: t.procedure.input(productSchemas.UpdateProductSchema).mutation(() => ({})),
    deleteProduct: t.procedure.input(productSchemas.DeleteProductSchema).mutation(() => ({})),
    searchProducts: t.procedure.input(productSchemas.SearchProductsSchema).query(() => ({})),
  }),
  user: t.router({
    getUser: t.procedure.input(userSchemas.GetUserSchema).query(() => ({})),
    createUser: t.procedure.input(userSchemas.CreateUserSchema).mutation(() => ({})),
    updateUser: t.procedure.input(userSchemas.UpdateUserSchema).mutation(() => ({})),
    deleteUser: t.procedure.input(userSchemas.DeleteUserSchema).mutation(() => ({})),
    listUsers: t.procedure.input(userSchemas.ListUsersSchema).query(() => ({})),
  }),
});

export type AppRouter = typeof staticAppRouter;
