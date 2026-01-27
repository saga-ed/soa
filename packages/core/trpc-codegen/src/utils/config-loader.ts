import path from 'path';
import type { TRPCCodegenConfig } from '../types/config.js';

export class ConfigLoader {
  static async loadConfig(configPath: string, _basePath?: string): Promise<TRPCCodegenConfig> {
    if (!configPath) {
      throw new Error('Config file path is required');
    }

    try {
      // Dynamic import for ESM/CJS compatibility
      const config = await import(path.resolve(configPath));
      const loadedConfig = config.default || config;
      
      // Validate the loaded config
      this.validateConfig(loadedConfig);
      
      return loadedConfig;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Config file not found: ${configPath}`);
      }
      if (error instanceof Error && error.message.includes('Failed to load url')) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      throw new Error(`Error loading config from ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  static validateConfig(config: TRPCCodegenConfig): void {
    if (!config.source?.sectorsDir) {
      throw new Error('source.sectorsDir is required');
    }
    if (!config.generation?.outputDir) {
      throw new Error('generation.outputDir is required');
    }
    if (!config.generation?.packageName) {
      throw new Error('generation.packageName is required');
    }
    if (!config.generation?.routerName) {
      throw new Error('generation.routerName is required');
    }
    if (!config.parsing?.endpointPattern) {
      throw new Error('parsing.endpointPattern is required');
    }
    if (!config.parsing?.routerMethodPattern) {
      throw new Error('parsing.routerMethodPattern is required');
    }
    if (config.zod2ts?.enabled === undefined) {
      throw new Error('zod2ts.enabled is required');
    }
    if (!config.zod2ts?.outputDir) {
      throw new Error('zod2ts.outputDir is required');
    }
  }

  static displayConfig(config: TRPCCodegenConfig, basePath: string, debug: boolean = false): void {
    console.log('📋 Configuration:');
    console.log(`  Source:`);
    console.log(`    Sectors directory: ${config.source.sectorsDir}`);
    console.log(`    Router pattern: ${config.source.routerPattern}`);
    console.log(`    Schema pattern: ${config.source.schemaPattern}`);
    
    console.log(`  Generation:`);
    console.log(`    Output directory: ${config.generation.outputDir}`);
    console.log(`    Package name: ${config.generation.packageName}`);
    console.log(`    Router name: ${config.generation.routerName}`);
    
    console.log(`  Parsing:`);
    console.log(`    Endpoint pattern: ${config.parsing.endpointPattern}`);
    console.log(`    Router method pattern: ${config.parsing.routerMethodPattern}`);
    
    console.log(`  Zod2TS:`);
    console.log(`    Enabled: ${config.zod2ts.enabled}`);
    if (config.zod2ts.enabled) {
      console.log(`    Output directory: ${config.zod2ts.outputDir}`);
    }
    
    if (debug) {
      console.log(`  Base path: ${basePath}`);
      console.log(`  Resolved paths:`);
      console.log(`    Sectors: ${path.resolve(basePath, config.source.sectorsDir)}`);
      console.log(`    Output: ${path.resolve(basePath, config.generation.outputDir)}`);
      if (config.zod2ts.enabled) {
        console.log(`    Types: ${path.resolve(basePath, config.zod2ts.outputDir)}`);
      }
    }
  }
}