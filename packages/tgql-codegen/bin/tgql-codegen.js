#!/usr/bin/env node

import 'reflect-metadata';
import { Command } from 'commander';
import { TGQLCodegen, ConfigLoader } from '../dist/index.js';

const program = new Command();

program
  .name('tgql-codegen')
  .description('TypeGraphQL code generation CLI for saga-soa')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate SDL files and TypeScript types from GraphQL resolvers')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('--sdl-only', 'Generate only SDL files (skip types)')
  .option('--types-only', 'Generate only TypeScript types from SDL (skip SDL generation)')
  .option('-o, --output-dir <path>', 'Output directory for generated files')
  .action(async (options) => {
    try {
      const config = await ConfigLoader.load(options.config);
      
      // Override output directory if specified
      if (options.outputDir) {
        config.generation.outputDir = options.outputDir;
        config.sdl.outputDir = `${options.outputDir}/schema`;
        config.graphqlCodegen.outputDir = `${options.outputDir}/types`;
      }
      
      const codegen = new TGQLCodegen(config);
      
      if (options.sdlOnly) {
        // Enable SDL generation, disable type generation
        config.sdl.enabled = true;
        config.graphqlCodegen.enabled = false;
        await codegen.generateSDLOnly();
      } else if (options.typesOnly) {
        // Enable type generation, disable SDL generation
        config.sdl.enabled = false;
        config.graphqlCodegen.enabled = true;
        await codegen.generateTypesOnly();
      } else {
        // Enable both phases
        config.sdl.enabled = true;
        config.graphqlCodegen.enabled = true;
        await codegen.generate();
      }
    } catch (error) {
      console.error('Generation failed:', error);
      process.exit(1);
    }
  });

program
  .command('emit-sdl')
  .description('Generate GraphQL SDL files from TypeGraphQL resolvers')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-o, --output <dir>', 'Output directory for SDL files')
  .option('--by-sector', 'Emit separate SDL files for each sector')
  .option('--unified', 'Emit single unified SDL file')
  .action(async (options) => {
    try {
      const config = await ConfigLoader.load(options.config);
      
      // Update config based on CLI options
      config.sdl.enabled = true;
      config.graphqlCodegen.enabled = false;
      
      if (options.output) {
        config.sdl.outputDir = options.output;
      }
      
      if (options.bySector) {
        config.sdl.emitBySector = true;
      } else if (options.unified) {
        config.sdl.emitBySector = false;
      }
      
      const codegen = new TGQLCodegen(config);
      await codegen.generateSDLOnly();
    } catch (error) {
      console.error('SDL generation failed:', error);
      process.exit(1);
    }
  });

program
  .command('emit-types')
  .description('Generate TypeScript types from GraphQL SDL files using graphql-codegen')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-s, --schema <path>', 'Path to GraphQL schema files')
  .option('-o, --output <dir>', 'Output directory for type files')
  .action(async (options) => {
    try {
      const config = await ConfigLoader.load(options.config);
      
      // Update config based on CLI options
      config.sdl.enabled = false;
      config.graphqlCodegen.enabled = true;
      
      if (options.schema) {
        config.graphqlCodegen.schemaPath = options.schema;
      }
      
      if (options.output) {
        config.graphqlCodegen.outputDir = options.output;
      }
      
      const codegen = new TGQLCodegen(config);
      await codegen.generateTypesOnly();
    } catch (error) {
      console.error('Type generation failed:', error);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch for file changes and regenerate types')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-o, --output-dir <path>', 'Output directory for generated files')
  .action(async (options) => {
    try {
      const config = await ConfigLoader.load(options.config);
      
      // Override output directory if specified
      if (options.outputDir) {
        config.generation.outputDir = options.outputDir;
        config.sdl.outputDir = `${options.outputDir}/schema`;
        config.graphqlCodegen.outputDir = `${options.outputDir}/types`;
      }
      
      const codegen = new TGQLCodegen(config);
      await codegen.watch();
    } catch (error) {
      console.error('Watch mode failed:', error);
      process.exit(1);
    }
  });

program.parse();