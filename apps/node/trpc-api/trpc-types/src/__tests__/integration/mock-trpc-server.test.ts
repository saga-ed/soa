import { describe, it, expect, expectTypeOf } from 'vitest';
import type { AppRouter } from '../../index.js';
import { CreateProjectSchema, CreateRunSchema } from '../../index.js';

describe('Generated Types Integration', () => {
  it('should export AppRouter type that matches tRPC expectations', () => {
    expectTypeOf<AppRouter>().toBeObject();
    expectTypeOf<AppRouter>().toHaveProperty('project');
    expectTypeOf<AppRouter>().toHaveProperty('run');
  });

  it('should export schemas that can validate input data', () => {
    // Test that the exported schemas work for validation
    const projectData = {
      name: 'Test Project',
      description: 'Test Description',
      status: 'active' as const,
    };
    
    const result = CreateProjectSchema.safeParse(projectData);
    expect(result.success).toBe(true);
    
    if (result.success) {
      expect(result.data.name).toBe('Test Project');
      expect(result.data.status).toBe('active');
    }
  });

  it('should export run schemas that can validate input data', () => {
    const runData = {
      projectId: '1',
      name: 'Test Run',
      description: 'Test Description',
      status: 'pending' as const,
    };
    
    const result = CreateRunSchema.safeParse(runData);
    expect(result.success).toBe(true);
    
    if (result.success) {
      expect(result.data.projectId).toBe('1');
      expect(result.data.name).toBe('Test Run');
      expect(result.data.status).toBe('pending');
    }
  });

  it('should have proper TypeScript type inference', () => {
    // This test ensures that the generated types work correctly for TypeScript
    type ProjectRouterType = AppRouter['project'];
    type RunRouterType = AppRouter['run'];
    
    expectTypeOf<ProjectRouterType>().toBeObject();
    expectTypeOf<RunRouterType>().toBeObject();
  });
});