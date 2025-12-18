import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { SchemaGenerator } from '../generators/schema-generator.js';
import { ConfigLoader } from '../utils/config-loader.js';
import { SectorParser } from '../parsers/sector-parser.js';

describe('SchemaGenerator', () => {
  let schemaGenerator: SchemaGenerator;
  let testConfig: any;
  let basePath: string;
  let sectors: any[];
  let outputDir: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root

    // Create unique temporary directory for this test
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-schema-test-'));

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

    schemaGenerator = new SchemaGenerator(testConfig, basePath);

    // Get sectors for testing with base config (not modified)
    const sectorParser = new SectorParser(baseConfig, basePath);
    sectors = await sectorParser.discoverSectors();
  });

  afterEach(async () => {
    // Clean up generated files after each test
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('generateSchemas()', () => {
    it('should copy schema files from test sectors', async () => {
      const generatedFiles = await schemaGenerator.generateSchemas(sectors);
      
      expect(generatedFiles.length).toBeGreaterThan(0);
      
      // Check that schema files were copied
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const schemasDir = path.join(outputDir, 'schemas');
      
      // Verify schemas directory exists
      const schemasDirExists = await fs.access(schemasDir).then(() => true).catch(() => false);
      expect(schemasDirExists).toBe(true);
      
      // Check that both schema files were copied
      const example1SchemaPath = path.join(schemasDir, 'example_sector1-schemas.ts');
      const example2SchemaPath = path.join(schemasDir, 'example_sector2-schemas.ts');

      const example1SchemaExists = await fs.access(example1SchemaPath).then(() => true).catch(() => false);
      const example2SchemaExists = await fs.access(example2SchemaPath).then(() => true).catch(() => false);

      expect(example1SchemaExists).toBe(true);
      expect(example2SchemaExists).toBe(true);
    });

    it('should generate schemas index file', async () => {
      await schemaGenerator.generateSchemas(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const schemasIndexPath = path.join(outputDir, 'schemas/index.ts');
      
      // Check that index file exists
      const indexExists = await fs.access(schemasIndexPath).then(() => true).catch(() => false);
      expect(indexExists).toBe(true);
      
      // Check index file content
      const indexContent = await fs.readFile(schemasIndexPath, 'utf-8');
      expect(indexContent).toContain("export * from './example_sector1-schemas.js';");
      expect(indexContent).toContain("export * from './example_sector2-schemas.js';");
    });

    it('should preserve schema file content', async () => {
      await schemaGenerator.generateSchemas(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const example1SchemaPath = path.join(outputDir, 'schemas/example_sector1-schemas.ts');

      // Check that the copied schema file contains expected content
      const example1SchemaContent = await fs.readFile(example1SchemaPath, 'utf-8');
      expect(example1SchemaContent).toContain('CreateItemSchema');
      expect(example1SchemaContent).toContain('UpdateItemSchema');
      expect(example1SchemaContent).toContain('GetItemSchema');
      expect(example1SchemaContent).toContain('DeleteItemSchema');
      expect(example1SchemaContent).toContain('ListItemsSchema');
    });

    it('should handle schema files with different patterns', async () => {
      // Test with custom schema pattern
      const customConfig = {
        ...testConfig,
        source: {
          ...testConfig.source,
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        }
      };
      
      const customSchemaGenerator = new SchemaGenerator(customConfig, basePath);
      const generatedFiles = await customSchemaGenerator.generateSchemas(sectors);
      
      expect(generatedFiles.length).toBeGreaterThan(0);
      
      // Verify files were generated
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const schemasDir = path.join(outputDir, 'schemas');
      
      const example1SchemaPath = path.join(schemasDir, 'example_sector1-schemas.ts');
      const example1SchemaExists = await fs.access(example1SchemaPath).then(() => true).catch(() => false);
      expect(example1SchemaExists).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle missing schema files gracefully', async () => {
      // Create a sector without a schema file
      const sectorWithoutSchema = {
        name: 'empty',
        endpoints: []
      };
      
      const result = await schemaGenerator.generateSchemas([sectorWithoutSchema]);
      
      // Should still generate the index file
      expect(result.length).toBeGreaterThan(0);
    });

    it('should create output directory if it does not exist', async () => {
      const customConfig = {
        ...testConfig,
        generation: {
          ...testConfig.generation,
          outputDir: './__tests__/output/new-directory'
        }
      };
      
      const customSchemaGenerator = new SchemaGenerator(customConfig, basePath);
      await customSchemaGenerator.generateSchemas(sectors);
      
      // Check that the new directory was created
      const newOutputDir = path.resolve(basePath, customConfig.generation.outputDir);
      const schemasDir = path.join(newOutputDir, 'schemas');
      
      const schemasDirExists = await fs.access(schemasDir).then(() => true).catch(() => false);
      expect(schemasDirExists).toBe(true);
    });
  });
});
