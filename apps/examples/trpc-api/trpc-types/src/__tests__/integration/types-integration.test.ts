import { describe, it, expect, expectTypeOf } from 'vitest';
import type { AppRouter } from '../../index.js';

describe('Generated Types Integration', () => {
  it('should export AppRouter type', () => {
    expectTypeOf<AppRouter>().toBeObject();
  });

  it('should have project and run router sections', () => {
    // This is a basic integration test to ensure the generated types work
    // The actual generation logic is tested in @hipponot/trpc-codegen
    expectTypeOf<AppRouter>().toHaveProperty('project');
    expectTypeOf<AppRouter>().toHaveProperty('run');
  });
});