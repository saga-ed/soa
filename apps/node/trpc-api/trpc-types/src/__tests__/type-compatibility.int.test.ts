import { describe, it, expect } from 'vitest';
import {
    CreateProjectSchema,
    UpdateProjectSchema,
    GetProjectSchema,
    CreateRunSchema,
    UpdateRunSchema,
    GetRunSchema,
    GetRunsByProjectSchema,
    type CreateProjectZ,
    type UpdateProjectZ,
    type GetProjectZ,
    type CreateRunZ,
    type UpdateRunZ,
    type GetRunZ,
    type GetRunsByProjectZ,
} from '../index.js';

const validCreateProject: CreateProjectZ = {
    name: 'Test Project',
    description: 'Test Description',
    status: 'active',
};

const validUpdateProject: UpdateProjectZ = {
    id: '1',
    name: 'Updated Project',
    description: 'Updated Description',
    status: 'inactive',
};

const validGetProject: GetProjectZ = {
    id: '1',
};

const validCreateRun: CreateRunZ = {
    projectId: '1',
    name: 'Test Run',
    description: 'Test Description',
    status: 'pending',
};

const validUpdateRun: UpdateRunZ = {
    id: '1',
    name: 'Updated Run',
    description: 'Updated Description',
    status: 'completed',
};

const validGetRun: GetRunZ = {
    id: '1',
};

describe('Type Compatibility', () => {
    describe('Zod Schema and TypeScript Type Compatibility', () => {
        it('should have compatible CreateProject types', () => {
            const zodResult = CreateProjectSchema.safeParse(validCreateProject);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: CreateProjectZ = zodResult.data;
                expect(typescriptType).toEqual(validCreateProject);
            }
        });

        it('should have compatible UpdateProject types', () => {
            const zodResult = UpdateProjectSchema.safeParse(validUpdateProject);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: UpdateProjectZ = zodResult.data;
                expect(typescriptType).toEqual(validUpdateProject);
            }
        });

        it('should have compatible GetProject types', () => {
            const zodResult = GetProjectSchema.safeParse(validGetProject);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: GetProjectZ = zodResult.data;
                expect(typescriptType).toEqual(validGetProject);
            }
        });

        it('should have compatible CreateRun types', () => {
            const zodResult = CreateRunSchema.safeParse(validCreateRun);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: CreateRunZ = zodResult.data;
                expect(typescriptType).toEqual(validCreateRun);
            }
        });

        it('should have compatible UpdateRun types', () => {
            const zodResult = UpdateRunSchema.safeParse(validUpdateRun);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: UpdateRunZ = zodResult.data;
                expect(typescriptType).toEqual(validUpdateRun);
            }
        });

        it('should have compatible GetRun types', () => {
            const zodResult = GetRunSchema.safeParse(validGetRun);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: GetRunZ = zodResult.data;
                expect(typescriptType).toEqual(validGetRun);
            }
        });

        it('should have compatible GetRunsByProject types', () => {
            const validData = { projectId: '1' };
            const zodResult = GetRunsByProjectSchema.safeParse(validData);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typescriptType: GetRunsByProjectZ = zodResult.data;
                expect(typescriptType).toEqual(validData);
            }
        });
    });

    describe('Runtime Validation with TypeScript Types', () => {
        it('should validate TypeScript types at runtime', () => {
            const createProjectData: CreateProjectZ = {
                name: 'Test Project',
                description: 'Test Description',
                status: 'active',
            };

            const result = CreateProjectSchema.safeParse(createProjectData);
            expect(result.success).toBe(true);

            if (result.success) {
                expect(result.data).toEqual(createProjectData);
            }
        });

        it('should handle optional fields correctly', () => {
            const minimalCreateProject = {
                name: 'Test Project',
            };

            const result = CreateProjectSchema.safeParse(minimalCreateProject);
            expect(result.success).toBe(true);

            if (result.success) {
                expect(result.data.name).toBe('Test Project');
                expect(result.data.status).toBe('active');
                expect(result.data.description).toBeUndefined();
            }
        });

        it('should handle partial updates correctly', () => {
            const partialUpdate: UpdateProjectZ = {
                id: '1',
                name: 'Updated Name',
            };

            const result = UpdateProjectSchema.safeParse(partialUpdate);
            expect(result.success).toBe(true);

            if (result.success) {
                expect(result.data.id).toBe('1');
                expect(result.data.name).toBe('Updated Name');
                expect(result.data.description).toBeUndefined();
                expect(result.data.status).toBeUndefined();
            }
        });
    });

    describe('Type Inference Consistency', () => {
        it('should have consistent type inference between Zod and TypeScript', () => {
            type ZodCreateProject = typeof CreateProjectSchema._type;

            const testData = {
                name: 'Test Project',
                description: 'Test Description',
                status: 'active' as const,
            };

            const zodResult = CreateProjectSchema.safeParse(testData);
            expect(zodResult.success).toBe(true);

            const typescriptData: CreateProjectZ = testData;
            expect(typescriptData).toEqual(testData);
        });

        it('should handle enum types consistently', () => {
            const validStatuses = ['active', 'inactive', 'archived'] as const;

            for (const status of validStatuses) {
                const testData = {
                    name: 'Test Project',
                    status,
                };

                const zodResult = CreateProjectSchema.safeParse(testData);
                expect(zodResult.success).toBe(true);

                if (zodResult.success) {
                    const typescriptData: CreateProjectZ = zodResult.data;
                    expect(typescriptData.status).toBe(status);
                }
            }
        });
    });

    describe('Error Handling Consistency', () => {
        it('should reject invalid data consistently', () => {
            const invalidData = {
                name: '',
                status: 'invalid' as any,
            };

            const zodResult = CreateProjectSchema.safeParse(invalidData);
            expect(zodResult.success).toBe(false);

            if (!zodResult.success) {
                expect(zodResult.error.issues).toHaveLength(2);
                expect(zodResult.error.issues.some(issue => issue.message === 'Project name is required')).toBe(true);
                expect(zodResult.error.issues.some(issue => issue.code === 'invalid_enum_value')).toBe(true);
            }
        });

        it('should handle missing required fields', () => {
            const invalidData = {
                status: 'active',
            };

            const zodResult = CreateProjectSchema.safeParse(invalidData);
            expect(zodResult.success).toBe(false);

            if (!zodResult.success) {
                expect(zodResult.error.issues.some(issue => issue.code === 'invalid_type')).toBe(true);
            }
        });
    });

    describe('Schema Types Compatibility', () => {
        it('should be compatible with inferred schema types', () => {
            const createProjectData = {
                name: 'Test Project',
                description: 'Test Description',
                status: 'active' as const,
            };

            const zodResult = CreateProjectSchema.safeParse(createProjectData);
            expect(zodResult.success).toBe(true);

            if (zodResult.success) {
                const typedData: CreateProjectZ = zodResult.data;
                expect(typedData).toEqual(createProjectData);
            }
        });
    });
});
