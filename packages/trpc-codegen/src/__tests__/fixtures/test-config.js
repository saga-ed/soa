import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  // Source configuration
  source: {
    sectorsDir: 'src/__tests__/fixtures/sectors',
    routerPattern: '*/trpc/*-router.ts',
    schemaPattern: '*/trpc/schema/*-schemas.ts'
  },
  
  // Generation configuration  
  generation: {
    outputDir: 'src/__tests__/fixtures/output',
    packageName: '@test/trpc-types',
    routerName: 'AppRouter'
  },
  
  // Parsing configuration
  parsing: {
    // Match the pattern: endpointName: t.procedure with optional .input(Schema) on next line, then .query/mutation
    endpointPattern: /(\w+):\s*t\.procedure\s*(?:\n\s*\.input\((\w+Schema)\))?\s*\n?\s*\.(query|mutation)\(/g,
    // Match the t.router({ ... }) pattern in test fixtures - match until });
    routerMethodPattern: /t\.router\(\s*\{([\s\S]*?)\}\s*\);/
  },

  // Zod2ts configuration
  zod2ts: {
    enabled: true,
    outputDir: './types'
  }
}
