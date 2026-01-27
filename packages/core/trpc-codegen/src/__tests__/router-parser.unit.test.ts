import { describe, it, expect } from 'vitest';
import { parseRouterFile } from '../parsers/router-parser.js';

describe('Router Parser', () => {
  describe('parseRouterFile()', () => {
    it('should parse router with input schemas correctly', () => {
      const routerContent = `
        export class UserController extends AbstractTRPCController {
          readonly sectorName = 'user';
          
          createRouter() {
            const t = this.createProcedure();
            return router({
              getUser: t.procedure
                .input(GetUserSchema)
                .query(() => ({})),
              
              createUser: t.procedure
                .input(CreateUserSchema)
                .mutation(() => ({})),
              
              updateUser: t.procedure
                .input(UpdateUserSchema)
                .mutation(() => ({})),
              
              deleteUser: t.procedure
                .input(DeleteUserSchema)
                .mutation(() => ({})),
              
              listUsers: t.procedure
                .input(ListUsersSchema)
                .query(() => ({}))
            });
          }
        }
      `;
      
      const endpoints = parseRouterFile(routerContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      expect(endpoints).toHaveLength(5);
      
      // Check endpoint names
      const endpointNames = endpoints.map(e => e.name).sort();
      expect(endpointNames).toEqual([
        'createUser',
        'deleteUser',
        'getUser',
        'listUsers',
        'updateUser'
      ]);
      
      // Check endpoint types
      const getUserEndpoint = endpoints.find(e => e.name === 'getUser');
      expect(getUserEndpoint?.type).toBe('query');
      expect(getUserEndpoint?.inputSchema).toBe('GetUserSchema');
      
      const createUserEndpoint = endpoints.find(e => e.name === 'createUser');
      expect(createUserEndpoint?.type).toBe('mutation');
      expect(createUserEndpoint?.inputSchema).toBe('CreateUserSchema');
    });

    it('should parse router without input schemas correctly', () => {
      const routerContent = `
        export class SimpleController extends AbstractTRPCController {
          readonly sectorName = 'simple';
          
          createRouter() {
            const t = this.createProcedure();
            return router({
              getStatus: t.procedure
                .query(() => ({ status: 'ok' })),
              
              ping: t.procedure
                .query(() => ({ pong: true }))
            });
          }
        }
      `;
      
      const endpoints = parseRouterFile(routerContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      expect(endpoints).toHaveLength(2);
      
      // Check endpoint names
      const endpointNames = endpoints.map(e => e.name).sort();
      expect(endpointNames).toEqual(['getStatus', 'ping']);
      
      // Check that endpoints without input schemas are handled
      const getStatusEndpoint = endpoints.find(e => e.name === 'getStatus');
      expect(getStatusEndpoint?.type).toBe('query');
      expect(getStatusEndpoint?.inputSchema).toBeUndefined();
    });

    it('should handle mixed input schema usage', () => {
      const routerContent = `
        export class MixedController extends AbstractTRPCController {
          readonly sectorName = 'mixed';
          
          createRouter() {
            const t = this.createProcedure();
            return router({
              getData: t.procedure
                .query(() => ({})),
              
              createData: t.procedure
                .input(CreateDataSchema)
                .mutation(() => ({})),
              
              updateData: t.procedure
                .input(UpdateDataSchema)
                .mutation(() => ({})),
              
              deleteData: t.procedure
                .query(() => ({}))
            });
          }
        }
      `;
      
      const endpoints = parseRouterFile(routerContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      expect(endpoints).toHaveLength(4);
      
      // Check endpoints with input schemas
      const createDataEndpoint = endpoints.find(e => e.name === 'createData');
      expect(createDataEndpoint?.inputSchema).toBe('CreateDataSchema');
      
      const updateDataEndpoint = endpoints.find(e => e.name === 'updateData');
      expect(updateDataEndpoint?.inputSchema).toBe('UpdateDataSchema');
      
      // Check endpoints without input schemas
      const getDataEndpoint = endpoints.find(e => e.name === 'getData');
      expect(getDataEndpoint?.inputSchema).toBeUndefined();
      
      const deleteDataEndpoint = endpoints.find(e => e.name === 'deleteData');
      expect(deleteDataEndpoint?.inputSchema).toBeUndefined();
    });

    it('should handle complex router patterns', () => {
      const routerContent = `
        export class ComplexController extends AbstractTRPCController {
          readonly sectorName = 'complex';
          
          createRouter() {
            const t = this.createProcedure();
            return router({
              getUserById: t.procedure
                .input(GetUserByIdSchema)
                .query(async ({ input }) => {
                  return { user: { id: input.id } };
                }),
              
              createUserWithValidation: t.procedure
                .input(CreateUserSchema)
                .mutation(async ({ input, ctx }) => {
                  return { success: true, userId: '123' };
                })
            });
          }
        }
      `;
      
      const endpoints = parseRouterFile(routerContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      expect(endpoints).toHaveLength(2);
      
      // Check complex endpoint names
      const endpointNames = endpoints.map(e => e.name).sort();
      expect(endpointNames).toEqual(['createUserWithValidation', 'getUserById']);
      
      // Check that complex input schemas are parsed correctly
      const getUserByIdEndpoint = endpoints.find(e => e.name === 'getUserById');
      expect(getUserByIdEndpoint?.inputSchema).toBe('GetUserByIdSchema');
      expect(getUserByIdEndpoint?.type).toBe('query');
    });

    it('should handle empty router gracefully', () => {
      const routerContent = `
        export class EmptyController extends AbstractTRPCController {
          readonly sectorName = 'empty';
          
          createRouter() {
            const t = this.createProcedure();
            return router({});
          }
        }
      `;
      
      const endpoints = parseRouterFile(routerContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      expect(endpoints).toHaveLength(0);
    });

    it('should handle malformed router content gracefully', () => {
      const malformedContent = `
        export class MalformedController extends AbstractTRPCController {
          readonly sectorName = 'malformed';
          
          createRouter() {
            const t = this.createProcedure();
            return router({
              invalidEndpoint: t.procedure
                // Missing .query() or .mutation()
            });
          }
        }
      `;
      
      const endpoints = parseRouterFile(malformedContent, {
        endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n\s*\.(query|mutation)\(/g,
        routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
      });
      
      // Should not crash, but may not parse correctly
      expect(Array.isArray(endpoints)).toBe(true);
    });
  });
});
