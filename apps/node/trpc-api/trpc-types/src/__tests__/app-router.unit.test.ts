import { describe, it, expect, expectTypeOf } from 'vitest';
import type { AppRouter } from '../../generated/router.js';
import type {
  CreateProject,
  UpdateProject,
  GetProject,
  CreateRun,
  UpdateRun,
  GetRun,
} from '../../generated/index.js';
import type { Project } from '../../../src/sectors/project/trpc/project.js';
import type { Run } from '../../../src/sectors/run/trpc/run.js';

describe('AppRouter Type', () => {
  it('should have project router structure', () => {
    expectTypeOf<AppRouter>().toHaveProperty('project');
    expectTypeOf<AppRouter['project']>().toBeObject();
  });

  it('should have run router structure', () => {
    expectTypeOf<AppRouter>().toHaveProperty('run');
    expectTypeOf<AppRouter['run']>().toBeObject();
  });

  it('should have correct project endpoints', () => {
    // Check that all expected procedures exist in project router
    expectTypeOf<AppRouter['project']>().toHaveProperty('getAllProjects');
    expectTypeOf<AppRouter['project']>().toHaveProperty('getProjectById');
    expectTypeOf<AppRouter['project']>().toHaveProperty('createProject');
    expectTypeOf<AppRouter['project']>().toHaveProperty('updateProject');
    expectTypeOf<AppRouter['project']>().toHaveProperty('deleteProject');
  });

  it('should have correct run endpoints', () => {
    // Check that all expected procedures exist in run router
    expectTypeOf<AppRouter['run']>().toHaveProperty('getAllRuns');
    expectTypeOf<AppRouter['run']>().toHaveProperty('getRunById');
    expectTypeOf<AppRouter['run']>().toHaveProperty('createRun');
    expectTypeOf<AppRouter['run']>().toHaveProperty('updateRun');
    expectTypeOf<AppRouter['run']>().toHaveProperty('deleteRun');
  });

  it('should export all required input types', () => {
    // Test that input types are properly exported and can be used
    const createProjectInput: CreateProject = {
      name: 'Test Project',
      description: 'Test Description',
      status: 'active',
    };
    
    const updateProjectInput: UpdateProject = {
      id: '1',
      name: 'Updated Project',
      description: 'Updated Description',
      status: 'inactive',
    };
    
    const getProjectInput: GetProject = {
      id: '1',
    };
    
    const createRunInput: CreateRun = {
      projectId: '1',
      name: 'Test Run',
      description: 'Test Description',
      status: 'running',
    };
    
    const updateRunInput: UpdateRun = {
      id: '1',
      name: 'Updated Run',
      description: 'Updated Description',
      status: 'completed',
    };
    
    const getRunInput: GetRun = {
      id: '1',
    };
    
    // These should all be valid and compile without errors
    expect(createProjectInput).toBeDefined();
    expect(updateProjectInput).toBeDefined();
    expect(getProjectInput).toBeDefined();
    expect(createRunInput).toBeDefined();
    expect(updateRunInput).toBeDefined();
    expect(getRunInput).toBeDefined();
  });

  it('should be compatible with tRPC client creation', () => {
    // This test ensures the AppRouter type can be used with tRPC client
    // We don't actually create a client, just test the type compatibility
    
    // Mock minimal tRPC client type structure
    type MinimalTRPCClient<T> = T extends Record<string, any> ? {
      [K in keyof T]: T[K] extends Record<string, any> ? MinimalTRPCClient<T[K]> : T[K]
    } : T;
    
    // This should compile without errors
    expectTypeOf<MinimalTRPCClient<AppRouter>>().toBeObject();
    expectTypeOf<MinimalTRPCClient<AppRouter>>().toHaveProperty('project');
    expectTypeOf<MinimalTRPCClient<AppRouter>>().toHaveProperty('run');
  });
});