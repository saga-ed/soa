import { describe, it, expect } from 'vitest';
import {
  CreateRunSchema,
  UpdateRunSchema,
  GetRunSchema,
  GetRunsByProjectSchema,
  type CreateRun,
  type UpdateRun,
  type GetRun,
  type GetRunsByProject,
} from '../index.js';

// Simple test data since we don't have the fixtures anymore
const validCreateRun = {
  projectId: '1',
  name: 'Test Run',
  description: 'Test Description',
  status: 'pending' as const,
  config: { key: 'value' },
};

const validUpdateRun = {
  id: '1',
  name: 'Updated Run',
  description: 'Updated Description',
  status: 'completed' as const,
  config: { key: 'updated' },
};

const validGetRun = {
  id: '1',
};

describe('Run Schemas', () => {
  describe('CreateRunSchema', () => {
    it('should validate correct run data', () => {
      const result = CreateRunSchema.safeParse(validCreateRun);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validCreateRun);
      }
    });

    it('should reject empty project ID', () => {
      const invalidData = { ...validCreateRun, projectId: '' };
      const result = CreateRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Project ID is required');
      }
    });

    it('should reject empty run name', () => {
      const invalidData = { ...validCreateRun, name: '' };
      const result = CreateRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Run name is required');
      }
    });

    it('should reject invalid status', () => {
      const invalidData = { ...validCreateRun, status: 'invalid' as any };
      const result = CreateRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.code).toBe('invalid_enum_value');
      }
    });

    it('should use default status when not provided', () => {
      const dataWithoutStatus = { 
        projectId: '1', 
        name: 'Test Run' 
      };
      const result = CreateRunSchema.safeParse(dataWithoutStatus);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.status).toBe('pending');
      }
    });

    it('should make description optional', () => {
      const dataWithoutDescription = { 
        projectId: '1', 
        name: 'Test Run' 
      };
      const result = CreateRunSchema.safeParse(dataWithoutDescription);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.description).toBeUndefined();
      }
    });

    it('should make config optional', () => {
      const dataWithoutConfig = { 
        projectId: '1', 
        name: 'Test Run' 
      };
      const result = CreateRunSchema.safeParse(dataWithoutConfig);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.config).toBeUndefined();
      }
    });

    it('should accept valid config', () => {
      const dataWithConfig = { 
        ...validCreateRun, 
        config: { key: 'value', number: 42 } 
      };
      const result = CreateRunSchema.safeParse(dataWithConfig);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.config).toEqual({ key: 'value', number: 42 });
      }
    });
  });

  describe('UpdateRunSchema', () => {
    it('should validate correct update data', () => {
      const result = UpdateRunSchema.safeParse(validUpdateRun);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validUpdateRun);
      }
    });

    it('should reject empty run ID', () => {
      const invalidData = { ...validUpdateRun, id: '' };
      const result = UpdateRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Run ID is required');
      }
    });

    it('should reject empty run name when provided', () => {
      const invalidData = { ...validUpdateRun, name: '' };
      const result = UpdateRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Run name is required');
      }
    });

    it('should allow partial updates', () => {
      const partialData = { id: '1', name: 'Updated Run' };
      const result = UpdateRunSchema.safeParse(partialData);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.id).toBe('1');
        expect(result.data.name).toBe('Updated Run');
        expect(result.data.description).toBeUndefined();
        expect(result.data.status).toBeUndefined();
        expect(result.data.config).toBeUndefined();
      }
    });
  });

  describe('GetRunSchema', () => {
    it('should validate correct get data', () => {
      const result = GetRunSchema.safeParse(validGetRun);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validGetRun);
      }
    });

    it('should reject empty run ID', () => {
      const invalidData = { id: '' };
      const result = GetRunSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe('Run ID is required');
      }
    });
  });

  describe('GetRunsByProjectSchema', () => {
    it('should validate correct project ID', () => {
      const validData = { projectId: '1' };
      const result = GetRunsByProjectSchema.safeParse(validData);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data).toEqual(validData);
      }
    });

    it('should reject empty project ID', () => {
      const invalidData = { projectId: '' };
      const result = GetRunsByProjectSchema.safeParse(invalidData);
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
      const createInput: CreateRun = {
        projectId: '1',
        name: 'Test Run',
        description: 'Test Description',
        status: 'running',
        config: { key: 'value' },
      };

      const updateInput: UpdateRun = {
        id: '1',
        name: 'Updated Run',
        description: 'Updated Description',
        status: 'completed',
        config: { key: 'updated' },
      };

      const getInput: GetRun = {
        id: '1',
      };

      const getByProjectInput: GetRunsByProject = {
        projectId: '1',
      };

      // Verify the types are correct
      expect(typeof createInput.projectId).toBe('string');
      expect(typeof createInput.name).toBe('string');
      expect(typeof updateInput.id).toBe('string');
      expect(typeof getInput.id).toBe('string');
      expect(typeof getByProjectInput.projectId).toBe('string');
    });
  });
}); 