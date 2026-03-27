// Re-export only the AppRouter TYPE from the server — zero runtime coupling
export type { AppRouter } from '../../src/app-router.js';

// Export Zod schemas for runtime validation (clients that want to validate)
export * from '../../src/sectors/project/trpc/schema/project-schemas.js';
export * from '../../src/sectors/run/trpc/schema/run-schemas.js';
export * from '../../src/sectors/pubsub/trpc/schema/pubsub-schemas.js';

// Export inferred types for convenience
export type { RouterInputs, RouterOutputs } from './helpers.js';
