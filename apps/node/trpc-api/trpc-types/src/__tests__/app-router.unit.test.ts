import { describe, it, expect, expectTypeOf } from 'vitest';
import type { AppRouter } from '../index.js';
import type {
    CreateProjectZ,
    UpdateProjectZ,
    GetProjectZ,
    CreateRunZ,
    UpdateRunZ,
    GetRunZ,
} from '../index.js';

describe('AppRouter Type', () => {
    it('should have project router structure', () => {
        expectTypeOf<AppRouter>().toHaveProperty('project');
        expectTypeOf<AppRouter['project']>().toBeObject();
    });

    it('should have run router structure', () => {
        expectTypeOf<AppRouter>().toHaveProperty('run');
        expectTypeOf<AppRouter['run']>().toBeObject();
    });

    it('should have pubsub router structure', () => {
        expectTypeOf<AppRouter>().toHaveProperty('pubsub');
        expectTypeOf<AppRouter['pubsub']>().toBeObject();
    });

    it('should have correct project endpoints', () => {
        expectTypeOf<AppRouter['project']>().toHaveProperty('getAllProjects');
        expectTypeOf<AppRouter['project']>().toHaveProperty('getProjectById');
        expectTypeOf<AppRouter['project']>().toHaveProperty('createProject');
        expectTypeOf<AppRouter['project']>().toHaveProperty('updateProject');
        expectTypeOf<AppRouter['project']>().toHaveProperty('deleteProject');
    });

    it('should have correct run endpoints', () => {
        expectTypeOf<AppRouter['run']>().toHaveProperty('getAllRuns');
        expectTypeOf<AppRouter['run']>().toHaveProperty('getRunById');
        expectTypeOf<AppRouter['run']>().toHaveProperty('createRun');
        expectTypeOf<AppRouter['run']>().toHaveProperty('updateRun');
        expectTypeOf<AppRouter['run']>().toHaveProperty('deleteRun');
    });

    it('should export all required input types', () => {
        const createProjectInput: CreateProjectZ = {
            name: 'Test Project',
            description: 'Test Description',
            status: 'active',
        };

        const updateProjectInput: UpdateProjectZ = {
            id: '1',
            name: 'Updated Project',
            description: 'Updated Description',
            status: 'inactive',
        };

        const getProjectInput: GetProjectZ = {
            id: '1',
        };

        const createRunInput: CreateRunZ = {
            projectId: '1',
            name: 'Test Run',
            description: 'Test Description',
            status: 'running',
        };

        const updateRunInput: UpdateRunZ = {
            id: '1',
            name: 'Updated Run',
            description: 'Updated Description',
            status: 'completed',
        };

        const getRunInput: GetRunZ = {
            id: '1',
        };

        expect(createProjectInput).toBeDefined();
        expect(updateProjectInput).toBeDefined();
        expect(getProjectInput).toBeDefined();
        expect(createRunInput).toBeDefined();
        expect(updateRunInput).toBeDefined();
        expect(getRunInput).toBeDefined();
    });

    it('should be compatible with tRPC client creation', () => {
        type MinimalTRPCClient<T> = T extends Record<string, any> ? {
            [K in keyof T]: T[K] extends Record<string, any> ? MinimalTRPCClient<T[K]> : T[K]
        } : T;

        expectTypeOf<MinimalTRPCClient<AppRouter>>().toBeObject();
        expectTypeOf<MinimalTRPCClient<AppRouter>>().toHaveProperty('project');
        expectTypeOf<MinimalTRPCClient<AppRouter>>().toHaveProperty('run');
        expectTypeOf<MinimalTRPCClient<AppRouter>>().toHaveProperty('pubsub');
    });
});
