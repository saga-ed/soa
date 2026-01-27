export default {
  // Source configuration
  source: {
    sectorsDir: '../src/sectors',
    routerPattern: '*/trpc/*-router.ts',
    schemaPattern: '*/trpc/schema/*-schemas.ts'
  },
  
  // Generation configuration  
  generation: {
    outputDir: './generated',
    packageName: '@saga-ed/soa-trpc-types',
    routerName: 'AppRouter'
  },
  
  // Parsing configuration
  parsing: {
    endpointPattern: /^\s*(\w+):\s*t\s*(?:\.input\((\w+Schema)\))?\s*\.(query|mutation)\(/gm,
    routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
  },

  // Zod2ts configuration
  zod2ts: {
    enabled: true,
    outputDir: './types'
  }
}; 