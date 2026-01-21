import { describe, it, expect } from 'vitest';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  GetProjectSchema,
  CreateRunSchema,
  UpdateRunSchema,
  GetRunSchema,
  GetRunsByProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type GetProjectInput,
  type CreateRunInput,
  type UpdateRunInput,
  type GetRunInput,
  type GetRunsByProjectInput,
} from '../../index.js';

// Simple test data
const validCreateProjectInput: CreateProjectInput = {
  name: 'Test Project',
  description: 'Test Description',
  status: 'active',
};

const validUpdateProjectInput: UpdateProjectInput = {
  id: '1',
  name: 'Updated Project',
  description: 'Updated Description',
  status: 'inactive',
};

const validGetProjectInput: GetProjectInput = {
  id: '1',
};

const validCreateRunInput: CreateRunInput = {
  projectId: '1',
  name: 'Test Run',
  description: 'Test Description',
  status: 'pending',
};

const validUpdateRunInput: UpdateRunInput = {
  id: '1',
  name: 'Updated Run',
  description: 'Updated Description',
  status: 'completed',
};

const validGetRunInput: GetRunInput = {
  id: '1',
};

describe('Type Compatibility', () => {
  describe('Zod Schema and TypeScript Type Compatibility', () => {
    it('should have compatible CreateProject types', () => {
      // Test that Zod schema and TypeScript type are compatible
      const zodResult = CreateProjectSchema.safeParse(validCreateProjectInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        // This should compile without errors - TypeScript type should match Zod output
        const typescriptType: CreateProjectInput = zodResult.data;
        expect(typescriptType).toEqual(validCreateProjectInput);
      }
    });

    it('should have compatible UpdateProject types', () => {
      const zodResult = UpdateProjectSchema.safeParse(validUpdateProjectInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: UpdateProjectInput = zodResult.data;
        expect(typescriptType).toEqual(validUpdateProjectInput);
      }
    });

    it('should have compatible GetProject types', () => {
      const zodResult = GetProjectSchema.safeParse(validGetProjectInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: GetProjectInput = zodResult.data;
        expect(typescriptType).toEqual(validGetProjectInput);
      }
    });

    it('should have compatible CreateRun types', () => {
      const zodResult = CreateRunSchema.safeParse(validCreateRunInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: CreateRunInput = zodResult.data;
        expect(typescriptType).toEqual(validCreateRunInput);
      }
    });

    it('should have compatible UpdateRun types', () => {
      const zodResult = UpdateRunSchema.safeParse(validUpdateRunInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: UpdateRunInput = zodResult.data;
        expect(typescriptType).toEqual(validUpdateRunInput);
      }
    });

    it('should have compatible GetRun types', () => {
      const zodResult = GetRunSchema.safeParse(validGetRunInput);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: GetRunInput = zodResult.data;
        expect(typescriptType).toEqual(validGetRunInput);
      }
    });

    it('should have compatible GetRunsByProject types', () => {
      const validData = { projectId: '1' };
      const zodResult = GetRunsByProjectSchema.safeParse(validData);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        const typescriptType: GetRunsByProjectInput = zodResult.data;
        expect(typescriptType).toEqual(validData);
      }
    });
  });

  describe('Runtime Validation with TypeScript Types', () => {
    it('should validate TypeScript types at runtime', () => {
      // Create data that matches TypeScript types
      const createProjectData: CreateProjectInput = {
        name: 'Test Project',
        description: 'Test Description',
        status: 'active',
      };

      // Validate with Zod schema
      const result = CreateProjectSchema.safeParse(createProjectData);
      expect(result.success).toBe(true);
      
      if (result.success) {
        // The validated data should match the TypeScript type
        expect(result.data).toEqual(createProjectData);
      }
    });

    it('should handle optional fields correctly', () => {
      // Test with minimal data (optional fields omitted)
      const minimalCreateProject = {
        name: 'Test Project',
        // description and status are optional
      };

      const result = CreateProjectSchema.safeParse(minimalCreateProject);
      expect(result.success).toBe(true);
      
      if (result.success) {
        // Zod should provide defaults for optional fields
        expect(result.data.name).toBe('Test Project');
        expect(result.data.status).toBe('active'); // default value
        expect(result.data.description).toBeUndefined();
      }
    });

    it('should handle partial updates correctly', () => {
      // Test partial update data
      const partialUpdate: UpdateProjectInput = {
        id: '1',
        name: 'Updated Name',
        // description and status are optional
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
      // Test that TypeScript types match Zod inferred types
      type ZodCreateProject = typeof CreateProjectSchema._type;
      type TypeScriptCreateProject = CreateProjectInput;
      
      // These should be equivalent types
      const testData = {
        name: 'Test Project',
        description: 'Test Description',
        status: 'active' as const,
      };
      
      // Both should accept the same data
      const zodResult = CreateProjectSchema.safeParse(testData);
      expect(zodResult.success).toBe(true);
      
      // TypeScript type should also accept this data
      const typescriptData: TypeScriptCreateProject = testData;
      expect(typescriptData).toEqual(testData);
    });

    it('should handle enum types consistently', () => {
      // Test that enum values are consistent between Zod and TypeScript
      const validStatuses = ['active', 'inactive', 'archived'] as const;
      
      for (const status of validStatuses) {
        const testData = {
          name: 'Test Project',
          status,
        };
        
        const zodResult = CreateProjectSchema.safeParse(testData);
        expect(zodResult.success).toBe(true);
        
        if (zodResult.success) {
          const typescriptData: CreateProjectInput = zodResult.data;
          expect(typescriptData.status).toBe(status);
        }
      }
    });
  });

  describe('Error Handling Consistency', () => {
    it('should reject invalid data consistently', () => {
      const invalidData = {
        name: '', // Invalid: empty name
        status: 'invalid' as any, // Invalid: invalid status
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
        // Missing required 'name' field
        status: 'active',
      };
      
      const zodResult = CreateProjectSchema.safeParse(invalidData);
      expect(zodResult.success).toBe(false);
      
      if (!zodResult.success) {
        expect(zodResult.error.issues.some(issue => issue.code === 'invalid_type')).toBe(true);
      }
    });
  });

  describe('Generated Types Compatibility', () => {
    it('should be compatible with generated types', () => {
      // Test that the generated types are compatible with the schema types
      // This ensures the zod2ts generated types work correctly
      
      const createProjectData = {
        name: 'Test Project',
        description: 'Test Description',
        status: 'active' as const,
      };
      
      // Should work with both Zod schema and TypeScript type
      const zodResult = CreateProjectSchema.safeParse(createProjectData);
      expect(zodResult.success).toBe(true);
      
      if (zodResult.success) {
        // Should also work with the generated type
        const generatedType: CreateProjectInput = zodResult.data;
        expect(generatedType).toEqual(createProjectData);
      }
    });
  });
}); 