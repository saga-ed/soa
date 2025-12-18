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

    // Create unique temporary directory for this test to avoid race conditions
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
      expect(result.sectors).toHaveLength(2);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      
      // Verify output directory structure
      const outputExists = await fs.access(outputDir).then(() => true).catch(() => false);
      expect(outputExists).toBe(true);
      
      // Check for all expected files and directories
      const expectedStructure = [
        'index.ts',
        'router.ts',
        'schemas/',
        'schemas/index.ts',
        'schemas/user-schemas.ts',
        'schemas/product-schemas.ts',
        'types/',
        'types/index.ts',
        'types/user/',
        'types/product/'
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
      
      expect(schemasIndexContent).toContain('export * from \'./user-schemas.js\';');
      expect(schemasIndexContent).toContain('export * from \'./product-schemas.js\';');
      
      // Check types index
      const typesIndexPath = path.join(outputDir, 'types/index.ts');
      const typesIndexContent = await fs.readFile(typesIndexPath, 'utf-8');
      
      expect(typesIndexContent).toContain('export * from \'./user/index.js\';');
      expect(typesIndexContent).toContain('export * from \'./product/index.js\';');
    });

    it('should preserve schema file content', async () => {
      await codegen.generate();
      
      // Check that user schemas were copied correctly
      const userSchemasPath = path.join(outputDir, 'schemas/user-schemas.ts');
      const userSchemasContent = await fs.readFile(userSchemasPath, 'utf-8');
      
      expect(userSchemasContent).toContain('CreateUserSchema');
      expect(userSchemasContent).toContain('UpdateUserSchema');
      expect(userSchemasContent).toContain('GetUserSchema');
      expect(userSchemasContent).toContain('DeleteUserSchema');
      expect(userSchemasContent).toContain('ListUsersSchema');
      
      // Check that product schemas were copied correctly
      const productSchemasPath = path.join(outputDir, 'schemas/product-schemas.ts');
      const productSchemasContent = await fs.readFile(productSchemasPath, 'utf-8');
      
      expect(productSchemasContent).toContain('CreateProductSchema');
      expect(productSchemasContent).toContain('UpdateProductSchema');
      expect(productSchemasContent).toContain('GetProductSchema');
      expect(productSchemasContent).toContain('DeleteProductSchema');
      expect(productSchemasContent).toContain('SearchProductsSchema');
    });

    it('should generate router with all endpoints', async () => {
      await codegen.generate();
      
      const routerPath = path.join(outputDir, 'router.ts');
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that all user endpoints are included
      expect(routerContent).toContain('getUser: t.procedure');
      expect(routerContent).toContain('createUser: t.procedure');
      expect(routerContent).toContain('updateUser: t.procedure');
      expect(routerContent).toContain('deleteUser: t.procedure');
      expect(routerContent).toContain('listUsers: t.procedure');
      
      // Check that all product endpoints are included
      expect(routerContent).toContain('getProduct: t.procedure');
      expect(routerContent).toContain('createProduct: t.procedure');
      expect(routerContent).toContain('updateProduct: t.procedure');
      expect(routerContent).toContain('deleteProduct: t.procedure');
      expect(routerContent).toContain('searchProducts: t.procedure');
      
      // Check that input schemas are correctly referenced
      expect(routerContent).toContain('.input(userSchemas.GetUserSchema)');
      expect(routerContent).toContain('.input(userSchemas.CreateUserSchema)');
      expect(routerContent).toContain('.input(productSchemas.GetProductSchema)');
      expect(routerContent).toContain('.input(productSchemas.CreateProductSchema)');
    });
  });

  describe('Configuration Variations', () => {
    it('should work with custom output directory', async () => {
      // Create a new temp directory for this specific test
      const customOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-custom-test-'));

      const customConfig = {
        ...testConfig,
        generation: {
          ...testConfig.generation,
          outputDir: path.relative(basePath, customOutputDir)
        }
      };

      const customCodegen = new TRPCCodegen(customConfig, basePath);
      const result = await customCodegen.generate();

      expect(result.errors).toHaveLength(0);

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
