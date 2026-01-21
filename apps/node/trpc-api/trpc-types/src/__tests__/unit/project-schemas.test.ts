import { describe, it, expect } from 'vitest';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  GetProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type GetProjectInput,
} from '../../index.js';

// Simple test data since we don't have the fixtures anymore
const validCreateProjectInput = {
  name: 'Test Project',
  description: 'Test Description',
  status: 'active' as const,
};

const validUpdateProjectInput = {
  id: '1',
  name: 'Updated Project',
  description: 'Updated Description',
  status: 'inactive' as const,
};

const validGetProjectInput = {
  id: '1',
};

const invalidGetProjectInput = {
  id: '',
};

describe('Project Schemas', () => {
  describe('CreateProjectSchema', () => {
    it('should validate correct project data', () => {
      const result = CreateProjectSchema.safeParse(validCreateProjectInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validCreateProjectInput);
      }
    });

    it('should reject empty project name', () => {
      const invalidData = { ...validCreateProjectInput, name: '' };
      const result = CreateProjectSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Project name is required');
      }
    });

    it('should reject invalid status', () => {
      const invalidData = { ...validCreateProjectInput, status: 'invalid' as any };
      const result = CreateProjectSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.code).toBe('invalid_enum_value');
      }
    });

    it('should use default status when not provided', () => {
      const dataWithoutStatus = { name: 'Test Project' };
      const result = CreateProjectSchema.safeParse(dataWithoutStatus);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.status).toBe('active');
      }
    });

    it('should make description optional', () => {
      const dataWithoutDescription = { name: 'Test Project' };
      const result = CreateProjectSchema.safeParse(dataWithoutDescription);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.description).toBeUndefined();
      }
    });
  });

  describe('UpdateProjectSchema', () => {
    it('should validate correct update data', () => {
      const result = UpdateProjectSchema.safeParse(validUpdateProjectInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validUpdateProjectInput);
      }
    });

    it('should reject empty project ID', () => {
      const invalidData = { ...validUpdateProjectInput, id: '' };
      const result = UpdateProjectSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Project ID is required');
      }
    });

    it('should reject empty project name when provided', () => {
      const invalidData = { ...validUpdateProjectInput, name: '' };
      const result = UpdateProjectSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Project name is required');
      }
    });

    it('should allow partial updates', () => {
      const partialData = { id: '1', name: 'Updated Name' };
      const result = UpdateProjectSchema.safeParse(partialData);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.id).toBe('1');
        expect(result.data.name).toBe('Updated Name');
        expect(result.data.description).toBeUndefined();
        expect(result.data.status).toBeUndefined();
      }
    });
  });

  describe('GetProjectSchema', () => {
    it('should validate correct get data', () => {
      const result = GetProjectSchema.safeParse(validGetProjectInput);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validGetProjectInput);
      }
    });

    it('should reject empty project ID', () => {
      const result = GetProjectSchema.safeParse(invalidGetProjectInput);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Project ID is required');
      }
    });
  });

  describe('TypeScript Type Inference', () => {
    it('should infer correct types from schemas', () => {
      // These should compile without errors
      const createInput: CreateProjectInput = {
        name: 'Test Project',
        description: 'Test Description',
        status: 'active',
      };

      const updateInput: UpdateProjectInput = {
        id: '1',
        name: 'Updated Project',
        description: 'Updated Description',
        status: 'inactive',
      };

      const getInput: GetProjectInput = {
        id: '1',
      };

      // Verify the types are correct
      expect(typeof createInput.name).toBe('string');
      expect(typeof updateInput.id).toBe('string');
      expect(typeof getInput.id).toBe('string');
    });
  });
}); 