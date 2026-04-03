import { describe, it, expect, expectTypeOf } from 'vitest';
import type { AppRouter } from '../index.js';

describe('Types Integration', () => {
    it('should export AppRouter type', () => {
        expectTypeOf<AppRouter>().toBeObject();
    });

    it('should have project and run router sections', () => {
        expectTypeOf<AppRouter>().toHaveProperty('project');
        expectTypeOf<AppRouter>().toHaveProperty('run');
    });

    it('should have pubsub router section', () => {
        expectTypeOf<AppRouter>().toHaveProperty('pubsub');
    });
});
