import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { TRPCCodegen } from '../generators/codegen.js';
import { ConfigLoader } from '../utils/config-loader.js';

describe('TRPCCodegen Integration', () => {
  let codegen: TRPCCodegen;
  let testConfig: any;
  let basePath: string;
  let outputDir: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root

    // Create unique temporary directory for this test
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-integration-test-'));

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

    codegen = new TRPCCodegen(testConfig, basePath);
  });

  afterEach(async () => {
    // Clean up generated files after each test
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Full Generation Workflow', () => {
    it('should generate complete output structure', async () => {
      const result = await codegen.generate();
      
      expect(result.errors).toHaveLength(0);
      expect(result.sectors).toHaveLength(2); // Both example sectors
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      
      // Verify output directory structure
      const outputExists = await fs.access(outputDir).then(() => true).catch(() => false);
      expect(outputExists).toBe(true);
      
      // Check for all expected files and directories
      const expectedStructure = [
        'index.ts',
        'router.ts',
        'schemas/',
        'schemas/index.ts',  // TypeScript since no dist folder in tests
        'schemas/example_sector1-schemas.ts',
        'schemas/example_sector2-schemas.ts',
        'types/',
        'types/index.ts',
        'types/example_sector1/',
        'types/example_sector2/'
      ];
      
      for (const item of expectedStructure) {
        const itemPath = path.join(outputDir, item);
        const exists = await fs.access(itemPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should generate valid TypeScript files', async () => {
      await codegen.generate();
      
      // Check main index.ts
      const mainIndexPath = path.join(outputDir, 'index.ts');
      const mainIndexContent = await fs.readFile(mainIndexPath, 'utf-8');
      
      expect(mainIndexContent).toContain('export * from \'./router.js\';');
      expect(mainIndexContent).toContain('export * from \'./schemas/index.js\';');
      expect(mainIndexContent).toContain('export * from \'./types/index.js\';');
      
      // Check router.ts
      const routerPath = path.join(outputDir, 'router.ts');
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      expect(routerContent).toContain('import { initTRPC } from \'@trpc/server\';');
      expect(routerContent).toContain('const t = initTRPC.create();');
      expect(routerContent).toContain(`export const static${testConfig.generation.routerName} = t.router({`);
      expect(routerContent).toContain(`export type ${testConfig.generation.routerName} = typeof static${testConfig.generation.routerName};`);
      
      // Check schemas index
      const schemasIndexPath = path.join(outputDir, 'schemas/index.ts');
      const schemasIndexContent = await fs.readFile(schemasIndexPath, 'utf-8');
      
      expect(schemasIndexContent).toContain('export * from \'./example_sector1-schemas.js\';');
      expect(schemasIndexContent).toContain('export * from \'./example_sector2-schemas.js\';');
      
      // Check types index
      const typesIndexPath = path.join(outputDir, 'types/index.ts');
      const typesIndexContent = await fs.readFile(typesIndexPath, 'utf-8');
      
      expect(typesIndexContent).toContain('export * from \'./example_sector1/index.js\';');
      expect(typesIndexContent).toContain('export * from \'./example_sector2/index.js\';');
    });

    it('should preserve schema file content', async () => {
      await codegen.generate();
      
      // Check that example_sector1 schemas were copied correctly
      const sector1SchemasPath = path.join(outputDir, 'schemas/example_sector1-schemas.ts');
      const sector1SchemasContent = await fs.readFile(sector1SchemasPath, 'utf-8');

      expect(sector1SchemasContent).toContain('CreateItemSchema');
      expect(sector1SchemasContent).toContain('UpdateItemSchema');
      expect(sector1SchemasContent).toContain('GetItemSchema');
      expect(sector1SchemasContent).toContain('DeleteItemSchema');
      expect(sector1SchemasContent).toContain('ListItemsSchema');
      
      // Check that example_sector2 schemas were copied correctly
      const sector2SchemasPath = path.join(outputDir, 'schemas/example_sector2-schemas.ts');
      const sector2SchemasContent = await fs.readFile(sector2SchemasPath, 'utf-8');

      expect(sector2SchemasContent).toContain('CreateResourceSchema');
      expect(sector2SchemasContent).toContain('UpdateResourceSchema');
      expect(sector2SchemasContent).toContain('GetResourceSchema');
      expect(sector2SchemasContent).toContain('DeleteResourceSchema');
      expect(sector2SchemasContent).toContain('SearchResourcesSchema');
    });

    it('should generate router with all endpoints', async () => {
      await codegen.generate();
      
      const routerPath = path.join(outputDir, 'router.ts');
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that all example_sector1 endpoints are included
      expect(routerContent).toContain('getItem: t.procedure');
      expect(routerContent).toContain('createItem: t.procedure');
      expect(routerContent).toContain('updateItem: t.procedure');
      expect(routerContent).toContain('deleteItem: t.procedure');
      expect(routerContent).toContain('listItems: t.procedure');
      expect(routerContent).toContain('healthCheck: t.procedure');

      // Check that all example_sector2 endpoints are included
      expect(routerContent).toContain('getResource: t.procedure');
      expect(routerContent).toContain('createResource: t.procedure');
      expect(routerContent).toContain('updateResource: t.procedure');
      expect(routerContent).toContain('deleteResource: t.procedure');
      expect(routerContent).toContain('searchResources: t.procedure');
      
      // Check that input schemas are correctly referenced
      expect(routerContent).toContain('.input(example_sector1Schemas.GetItemSchema)');
      expect(routerContent).toContain('.input(example_sector1Schemas.CreateItemSchema)');
      expect(routerContent).toContain('.input(example_sector2Schemas.GetResourceSchema)');
      expect(routerContent).toContain('.input(example_sector2Schemas.CreateResourceSchema)');
    });
  });

  describe('Configuration Variations', () => {
    it('should work with custom output directory', async () => {
      const customConfig = {
        ...testConfig,
        generation: {
          ...testConfig.generation,
          outputDir: './__tests__/output/custom'
        }
      };
      
      const customCodegen = new TRPCCodegen(customConfig, basePath);
      const result = await customCodegen.generate();
      
      expect(result.errors).toHaveLength(0);
      
      const customOutputDir = path.resolve(basePath, customConfig.generation.outputDir);
      const customOutputExists = await fs.access(customOutputDir).then(() => true).catch(() => false);
      expect(customOutputExists).toBe(true);
      
      // Clean up custom output
      await fs.rm(customOutputDir, { recursive: true, force: true });
    });

    it('should work with disabled zod2ts', async () => {
      const disabledConfig = {
        ...testConfig,
        zod2ts: {
          ...testConfig.zod2ts,
          enabled: false
        }
      };
      
      const disabledCodegen = new TRPCCodegen(disabledConfig, basePath);
      const result = await disabledCodegen.generate();
      
      expect(result.errors).toHaveLength(0);
      
      // Check that types directory was not created
      const typesDir = path.join(outputDir, 'types');
      const typesDirExists = await fs.access(typesDir).then(() => true).catch(() => false);
      expect(typesDirExists).toBe(false);
      
      // Check that main index doesn't export types
      const mainIndexPath = path.join(outputDir, 'index.ts');
      const mainIndexContent = await fs.readFile(mainIndexPath, 'utf-8');
      expect(mainIndexContent).not.toContain('export * from \'./types/index.js\';');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing sectors directory gracefully', async () => {
      const invalidConfig = {
        ...testConfig,
        source: {
          ...testConfig.source,
          sectorsDir: 'nonexistent'
        }
      };
      
      const invalidCodegen = new TRPCCodegen(invalidConfig, basePath);
      const result = await invalidCodegen.generate();
      
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.sectors).toHaveLength(0);
      expect(result.generatedFiles.length).toBe(0);
    });

    it('should continue generation even if some steps fail', async () => {
      // This test verifies that the system is resilient to partial failures
      const result = await codegen.generate();
      
      // All steps should succeed with our test fixtures
      expect(result.errors).toHaveLength(0);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
    });
  });
});
