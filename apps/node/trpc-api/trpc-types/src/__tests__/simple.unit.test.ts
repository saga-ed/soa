import { describe, it, expect } from 'vitest';

describe('Simple Test', () => {
  it('should pass', () => {
    expect(1 + 1).toBe(2);
  });
  
  it('should be able to import and use basic types', async () => {
    // Dynamic import to test the actual package structure
    const { CreateProjectSchema } = await import('../index.js');
    
    const result = CreateProjectSchema.safeParse({
      name: 'Test Project',
      status: 'active'
    });
    
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Test Project');
      expect(result.data.status).toBe('active');
    }
  });
});