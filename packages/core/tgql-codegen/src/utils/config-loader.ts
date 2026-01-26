import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TGQLCodegenConfig } from '../types/config.js';
import { DEFAULT_CONFIG } from '../types/config.js';

export class ConfigLoader {
  static async load(configPath?: string): Promise<TGQLCodegenConfig> {
    const defaultPaths = [
      'tgql-codegen.config.js',
      'codegen.config.js'
    ];

    const pathsToTry = configPath ? [configPath] : defaultPaths;
    
    for (const path of pathsToTry) {
      const fullPath = configPath ? resolve(path) : resolve(process.cwd(), path);
      if (existsSync(fullPath)) {
        try {
          // Use dynamic import for ESM modules
          const fileUrl = pathToFileURL(fullPath).href;
          const config = await import(fileUrl + '?t=' + Date.now()); // Add cache busting
          return this.mergeConfig(config.default || config, fullPath);
        } catch (error) {
          console.warn(`Warning: Failed to load config from ${fullPath}:`, error);
        }
      }
    }

    console.log('No config file found, using default configuration');
    return DEFAULT_CONFIG;
  }


  private static mergeConfig(userConfig: Partial<TGQLCodegenConfig>, configFilePath?: string): TGQLCodegenConfig {
    const mergedConfig = {
      source: { ...DEFAULT_CONFIG.source, ...(userConfig?.source || {}) },
      generation: { ...DEFAULT_CONFIG.generation, ...(userConfig?.generation || {}) },
      parsing: { ...DEFAULT_CONFIG.parsing, ...(userConfig?.parsing || {}) },
      sdl: { ...DEFAULT_CONFIG.sdl, ...(userConfig?.sdl || {}) },
      graphqlCodegen: { ...DEFAULT_CONFIG.graphqlCodegen, ...(userConfig?.graphqlCodegen || {}) },
    };

    // If we have a config file path, resolve relative paths relative to the config file
    if (configFilePath && userConfig?.source) {
      const configDir = resolve(configFilePath, '..');
      console.log(`ConfigLoader debug: configFilePath=${configFilePath}, configDir=${configDir}`);
      console.log(`ConfigLoader debug: original sectorsDir=${userConfig.source.sectorsDir}`);
      
      // Resolve sectorsDir relative to config file if it's not absolute
      if (userConfig.source.sectorsDir && !userConfig.source.sectorsDir.startsWith('/')) {
        mergedConfig.source.sectorsDir = resolve(configDir, userConfig.source.sectorsDir);
        console.log(`ConfigLoader debug: resolved sectorsDir=${mergedConfig.source.sectorsDir}`);
      }
      
      // Resolve outputDir relative to config file if it's not absolute  
      if (userConfig.generation?.outputDir && !userConfig.generation.outputDir.startsWith('/')) {
        mergedConfig.generation.outputDir = resolve(configDir, userConfig.generation.outputDir);
        console.log(`ConfigLoader debug: resolved outputDir=${mergedConfig.generation.outputDir}`);
      }

      // Resolve SDL outputDir relative to config file if it's not absolute
      if (userConfig.sdl?.outputDir && !userConfig.sdl.outputDir.startsWith('/')) {
        mergedConfig.sdl.outputDir = resolve(configDir, userConfig.sdl.outputDir);
        console.log(`ConfigLoader debug: resolved sdl.outputDir=${mergedConfig.sdl.outputDir}`);
      }

      // Resolve GraphQL CodeGen outputDir relative to config file if it's not absolute
      if (userConfig.graphqlCodegen?.outputDir && !userConfig.graphqlCodegen.outputDir.startsWith('/')) {
        mergedConfig.graphqlCodegen.outputDir = resolve(configDir, userConfig.graphqlCodegen.outputDir);
        console.log(`ConfigLoader debug: resolved graphqlCodegen.outputDir=${mergedConfig.graphqlCodegen.outputDir}`);
      }
    }

    return mergedConfig;
  }
}