#!/usr/bin/env tsx

import { Command } from 'commander';
import { resolve } from 'node:path';
import { SchemaExtractor } from './schema-extractor.js';
import { ZodSchemaLoader } from './zod-loader.js';
import { TypeGenerator } from './type-generator.js';
import { validateFileExists } from './file-utils.js';
import { ZodToTsError } from './types.js';

const program = new Command();

program
  .name('zod2ts')
  .description('Extract fully realized TypeScript types from Zod schemas')
  .version('1.0.0')
  .requiredOption('--zod-path <path>', 'Path to TypeScript (.ts) or JavaScript (.js) file containing Zod schemas')
  .requiredOption('--output-dir <path>', 'Output directory for generated type files')
  .option(
    '--type-name <name>',
    'Override the generated type name (default: removes "Schema" suffix or uses schema name)'
  )
  .action(async options => {
    try {
      const { zodPath, outputDir, typeName } = options;

      // Validate input file exists
      validateFileExists(zodPath);

      // Resolve paths
      const resolvedZodPath = resolve(zodPath);
      const resolvedOutputDir = resolve(outputDir);

      console.log(`Processing Zod schemas from: ${resolvedZodPath}`);
      console.log(`Output directory: ${resolvedOutputDir}`);

      // Create dependencies
      const zodLoader = new ZodSchemaLoader();
      const typeGenerator = new TypeGenerator();
      const extractor = new SchemaExtractor(zodLoader, typeGenerator);

      // Extract schemas
      const result = await extractor.extractSchemas(resolvedZodPath, resolvedOutputDir, typeName);

      // Report results
      console.log(`\n✅ Successfully extracted ${result.schemas.length} schema(s):`);
      for (const schema of result.schemas) {
        console.log(`  - ${schema.name} → ${schema.typeName}`);
      }

      console.log(`\n📁 Generated type files:`);
      for (const file of result.outputFiles) {
        console.log(`  - ${file}`);
      }
    } catch (error) {
      if (error instanceof ZodToTsError) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
      } else {
        console.error('❌ Unexpected error:', error);
        process.exit(1);
      }
    }
  });

program.parse();
