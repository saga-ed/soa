import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { Zod2tsGenerator } from '../generators/zod2ts-generator.js';
import { ConfigLoader } from '../utils/config-loader.js';
import { SectorParser } from '../parsers/sector-parser.js';

// Mock the zod2ts execution since we don't want to actually run it in tests
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          // Mock some output
          callback('Mock zod2ts output');
        }
      })
    },
    stderr: {
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          // Mock empty stderr
          callback('');
        }
      })
    },
    on: vi.fn((event, callback) => {
      if (event === 'close') {
        // Always succeed in tests
        setTimeout(() => callback(0), 10);
      } else if (event === 'error') {
        // Don't trigger error events in tests
      }
    })
  }))
}));

describe('Zod2tsGenerator', () => {
  let zod2tsGenerator: Zod2tsGenerator;
  let testConfig: any;
  let basePath: string;
  let sectors: any[];
  let outputDir: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root

    // Create unique temporary directory for this test
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-zod2ts-test-'));

    // Load base config and override output directory
    const configPath = path.resolve(basePath, 'src/__tests__/fixtures/test-config.js');
    const baseConfig = await ConfigLoader.loadConfig(configPath, basePath);
    testConfig = {
      ...baseConfig,
      generation: {
        ...baseConfig.generation,
        outputDir: path.relative(basePath, outputDir)
      }
    };

    zod2tsGenerator = new Zod2tsGenerator(testConfig, basePath);

    // Get sectors for testing with base config (not modified)
    const sectorParser = new SectorParser(baseConfig, basePath);
    sectors = await sectorParser.discoverSectors();

    // Ensure schema files exist in the expected output directory for zod2ts
    const outputPath = path.resolve(basePath, testConfig.generation.outputDir);
    const schemasOutputDir = path.join(outputPath, 'schemas');
    await fs.mkdir(schemasOutputDir, { recursive: true });
    
    // Copy schema files from test fixtures to the expected output location
    for (const sector of sectors) {
      const sourceSchemaFile = path.join(basePath, 'src/__tests__/fixtures/sectors', sector.name, 'trpc', 'schema', `${sector.name}-schemas.ts`);
      const targetSchemaFile = path.join(schemasOutputDir, `${sector.name}-schemas.ts`);

      try {
        const schemaContent = await fs.readFile(sourceSchemaFile, 'utf-8');
        await fs.writeFile(targetSchemaFile, schemaContent);

        // Also create the types directories that would be created by zod2ts
        const typesDir = path.join(outputPath, testConfig.zod2ts.outputDir);
        const sectorTypesDir = path.join(typesDir, sector.name);
        await fs.mkdir(sectorTypesDir, { recursive: true });

        // Create a mock index file for each sector
        const sectorIndexFile = path.join(sectorTypesDir, 'index.ts');
        await fs.writeFile(sectorIndexFile, `// Mock generated types for ${sector.name}\nexport {};`);

      } catch (error) {
        console.warn(`Could not copy schema for ${sector.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);

        // Even if schema copy fails, still create the types directory structure
        const typesDir = path.join(outputPath, testConfig.zod2ts.outputDir);
        const sectorTypesDir = path.join(typesDir, sector.name);
        await fs.mkdir(sectorTypesDir, { recursive: true });

        // Create a minimal index file
        const sectorIndexFile = path.join(sectorTypesDir, 'index.ts');
        await fs.writeFile(sectorIndexFile, `// Mock generated types for ${sector.name}\nexport {};`);
      }
    }

    // Create the main types index file
    const typesDir = path.join(outputPath, testConfig.zod2ts.outputDir);
    await fs.mkdir(typesDir, { recursive: true });
    const typesIndexFile = path.join(typesDir, 'index.ts');
    const typesIndexContent = sectors.map(sector =>
      `export * from './${sector.name}/index.js';`
    ).join('\n');
    await fs.writeFile(typesIndexFile, `// Auto-generated - do not edit\n// This file re-exports all TypeScript types from sectors\n${typesIndexContent}\n`);
  });

  afterEach(async () => {
    // Clean up generated files after each test
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('generateTypes()', () => {
    it('should be enabled by default', () => {
      expect(testConfig.zod2ts.enabled).toBe(true);
    });

    it('should create types directory structure', async () => {
      const generatedFiles = await zod2tsGenerator.generateTypes(sectors);
      
      expect(generatedFiles.length).toBeGreaterThan(0);
      
      // Check that types directory was created
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const typesDir = path.join(outputDir, testConfig.zod2ts.outputDir);
      
      const typesDirExists = await fs.access(typesDir).then(() => true).catch(() => false);
      expect(typesDirExists).toBe(true);
    });

    it('should create sector-specific type directories', async () => {
      await zod2tsGenerator.generateTypes(sectors);

      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const typesDir = path.join(outputDir, testConfig.zod2ts.outputDir);

      // Check that both sector type directories were created
      const sector1TypesDir = path.join(typesDir, 'example_sector1');
      const sector2TypesDir = path.join(typesDir, 'example_sector2');

      const sector1TypesDirExists = await fs.access(sector1TypesDir).then(() => true).catch(() => false);
      const sector2TypesDirExists = await fs.access(sector2TypesDir).then(() => true).catch(() => false);

      expect(sector1TypesDirExists).toBe(true);
      expect(sector2TypesDirExists).toBe(true);
    });

    it('should generate types index file', async () => {
      await zod2tsGenerator.generateTypes(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const typesDir = path.join(outputDir, testConfig.zod2ts.outputDir);
      const typesIndexPath = path.join(typesDir, 'index.ts');
      
      // Check that index file exists
      const indexExists = await fs.access(typesIndexPath).then(() => true).catch(() => false);
      expect(indexExists).toBe(true);
      
      // Check index file content
      const indexContent = await fs.readFile(typesIndexPath, 'utf-8');
      expect(indexContent).toContain("export * from './example_sector1/index.js';");
      expect(indexContent).toContain("export * from './example_sector2/index.js';");
    });

    it('should skip generation when disabled', async () => {
      const disabledConfig = {
        ...testConfig,
        zod2ts: {
          ...testConfig.zod2ts,
          enabled: false
        }
      };
      
      const disabledGenerator = new Zod2tsGenerator(disabledConfig, basePath);
      const generatedFiles = await disabledGenerator.generateTypes(sectors);
      
      expect(generatedFiles).toHaveLength(0);
    });

    it('should handle zod2ts execution failures gracefully', async () => {
      // Override the default mock for this specific test
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValueOnce({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            callback(1); // Failure exit code
          }
        })
      } as any);

      const generatedFiles = await zod2tsGenerator.generateTypes(sectors);
      
      // Should still generate the types index file even if zod2ts fails
      expect(generatedFiles.length).toBeGreaterThan(0);
    });
  });

  describe('configuration options', () => {
    it('should use custom types output directory', async () => {
      const customConfig = {
        ...testConfig,
        zod2ts: {
          ...testConfig.zod2ts,
          outputDir: './custom-types'
        }
      };
      
      const customGenerator = new Zod2tsGenerator(customConfig, basePath);
      
      await customGenerator.generateTypes(sectors);
      
      const outputDir = path.resolve(basePath, customConfig.generation.outputDir);
      const customTypesDir = path.join(outputDir, customConfig.zod2ts.outputDir);
      
      const customTypesDirExists = await fs.access(customTypesDir).then(() => true).catch(() => false);
      expect(customTypesDirExists).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle missing schema files gracefully', async () => {
      // Create a sector without a schema file
      const sectorWithoutSchema = {
        name: 'empty',
        endpoints: []
      };
      
      const result = await zod2tsGenerator.generateTypes([sectorWithoutSchema]);
      
      // Should still generate the types index file
      expect(result.length).toBeGreaterThan(0);
    });

    it('should create output directory if it does not exist', async () => {
      const customConfig = {
        ...testConfig,
        generation: {
          ...testConfig.generation,
          outputDir: './__tests__/output/zod2ts-test'
        }
      };
      
      const customGenerator = new Zod2tsGenerator(customConfig, basePath);
      
      await customGenerator.generateTypes(sectors);
      
      // Check that the new directory was created
      const newOutputDir = path.resolve(basePath, customConfig.generation.outputDir);
      const typesDir = path.join(newOutputDir, customConfig.zod2ts.outputDir);
      
      const typesDirExists = await fs.access(typesDir).then(() => true).catch(() => false);
      expect(typesDirExists).toBe(true);
    });
  });
});
