#!/usr/bin/env node

import { Command } from 'commander';
import { TRPCCodegen } from '../dist/index.js';
import { ConfigLoader } from '../dist/index.js';
import { watch } from 'chokidar';
import path from 'path';

const program = new Command();

program
  .name('trpc-codegen')
  .description('Generate TypeScript types and router from tRPC sector-based API')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate tRPC types and router')
  .requiredOption('-c, --config <path>', 'Path to config file (required)')
  .option('-p, --project <path>', 'Project directory path', process.cwd())
  .option('--dry-run', 'Show what would be generated without creating files')
  .option('--debug', 'Enable verbose debug output', false)
  .action(async (options) => {
    try {
      // Display working directory and command line
      console.log(`Working directory: ${process.cwd()}`);
      console.log(`Command: ${process.argv.join(' ')}`);
      console.log('');

      const config = await ConfigLoader.loadConfig(options.config, options.project);
      
      // Display configuration
      ConfigLoader.displayConfig(config, options.project, options.debug);
      console.log('');

      if (options.dryRun) {
        console.log('📋 Dry run mode - no files will be generated');
        return;
      }

      const codegen = new TRPCCodegen(config, options.project, false);
      const result = await codegen.generate();
      
      if (result.errors.length > 0) {
        console.error('❌ Generation completed with errors:');
        result.errors.forEach(error => console.error(`  - ${error}`));
        process.exit(1);
      }
      
      console.log(`✅ Generation completed successfully! Generated ${result.generatedFiles.length} files.`);
    } catch (error) {
      console.error('❌ Fatal error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch for changes and regenerate automatically')
  .requiredOption('-c, --config <path>', 'Path to config file (required)')
  .option('-p, --project <path>', 'Project directory path', process.cwd())
  .option('--debug', 'Enable verbose debug output', false)
  .action(async (options) => {
    try {
      // Display working directory and command line
      console.log(`Working directory: ${process.cwd()}`);
      console.log(`Command: ${process.argv.join(' ')}`);
      console.log('');

      const config = await ConfigLoader.loadConfig(options.config, options.project);
      
      // Display configuration
      ConfigLoader.displayConfig(config, options.project, options.debug);
      console.log('');

      console.log('👀 Starting watch mode...');
      const codegen = new TRPCCodegen(config, options.project, false);
      
      // Initial generation
      await codegen.generate();
      
      // Watch for changes
      const sectorsDir = path.resolve(options.project, config.source.sectorsDir);
      console.log(`🔍 Watching for changes in: ${sectorsDir}`);
      
      const watcher = watch(sectorsDir, {
        ignored: /node_modules|\.git/,
        persistent: true
      });
      
      watcher.on('change', async (filePath) => {
        console.log(`📝 File changed: ${path.relative(options.project, filePath)}`);
        try {
          await codegen.generate();
          console.log('✅ Regeneration completed');
        } catch (error) {
          console.error('❌ Regeneration failed:', error instanceof Error ? error.message : 'Unknown error');
        }
      });
      
      console.log('Press Ctrl+C to stop watching');
    } catch (error) {
      console.error('❌ Fatal error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

program.parse();