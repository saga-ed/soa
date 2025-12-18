import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { RouterGenerator } from '../generators/router-generator.js';
import { ConfigLoader } from '../utils/config-loader.js';
import { SectorParser } from '../parsers/sector-parser.js';

describe('RouterGenerator', () => {
  let routerGenerator: RouterGenerator;
  let testConfig: any;
  let basePath: string;
  let sectors: any[];
  let outputDir: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root

    // Create unique temporary directory for this test
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-router-test-'));

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

    routerGenerator = new RouterGenerator(testConfig, basePath);

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

  describe('generateRouter()', () => {
    it('should generate router file with correct structure', async () => {
      const routerFile = await routerGenerator.generateRouter(sectors);
      
      expect(routerFile).toBeDefined();
      
      // Check that router file was created
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerExists = await fs.access(routerPath).then(() => true).catch(() => false);
      expect(routerExists).toBe(true);
    });

    it('should import all sector schemas correctly', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that both sector schemas are imported
      expect(routerContent).toContain("import * as example_sector1Schemas from './schemas/example_sector1-schemas.js';");
      expect(routerContent).toContain("import * as example_sector2Schemas from './schemas/example_sector2-schemas.js';");
    });

    it('should generate router with all sectors', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that both sectors are included in the router
      expect(routerContent).toContain('example_sector1: t.router({');
      expect(routerContent).toContain('example_sector2: t.router({');
    });

    it('should include all endpoints from each sector', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check example_sector1 endpoints
      expect(routerContent).toContain('getItem: t.procedure');
      expect(routerContent).toContain('createItem: t.procedure');
      expect(routerContent).toContain('updateItem: t.procedure');
      expect(routerContent).toContain('deleteItem: t.procedure');
      expect(routerContent).toContain('listItems: t.procedure');
      expect(routerContent).toContain('healthCheck: t.procedure');

      // Check example_sector2 endpoints
      expect(routerContent).toContain('getResource: t.procedure');
      expect(routerContent).toContain('createResource: t.procedure');
      expect(routerContent).toContain('updateResource: t.procedure');
      expect(routerContent).toContain('deleteResource: t.procedure');
      expect(routerContent).toContain('searchResources: t.procedure');
    });

    it('should use correct input schemas for each endpoint', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that input schemas are correctly referenced
      expect(routerContent).toContain('.input(example_sector1Schemas.GetItemSchema)');
      expect(routerContent).toContain('.input(example_sector1Schemas.CreateItemSchema)');
      expect(routerContent).toContain('.input(example_sector2Schemas.GetResourceSchema)');
      expect(routerContent).toContain('.input(example_sector2Schemas.CreateResourceSchema)');
    });

    it('should generate correct procedure types', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that query and mutation procedures are correctly typed
      expect(routerContent).toContain('.query(');
      expect(routerContent).toContain('.mutation(');
    });

    it('should create output directory if it does not exist', async () => {
      const customConfig = {
        ...testConfig,
        generation: {
          ...testConfig.generation,
          outputDir: './__tests__/output/router-test'
        }
      };
      
      const customRouterGenerator = new RouterGenerator(customConfig, basePath);
      await customRouterGenerator.generateRouter(sectors);
      
      // Check that the new directory was created
      const newOutputDir = path.resolve(basePath, customConfig.generation.outputDir);
      const routerPath = path.join(newOutputDir, 'router.ts');
      
      const routerExists = await fs.access(routerPath).then(() => true).catch(() => false);
      expect(routerExists).toBe(true);
    });
  });

  describe('router content validation', () => {
    it('should generate valid TypeScript syntax', async () => {
      await routerGenerator.generateRouter(sectors);
      
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check for basic TypeScript structure
      expect(routerContent).toContain('import { initTRPC } from \'@trpc/server\';');
      expect(routerContent).toContain('const t = initTRPC.create();');
      expect(routerContent).toContain('export const staticAppRouter = t.router({');
      expect(routerContent).toContain('export type AppRouter = typeof staticAppRouter;');
    });

    it('should handle sectors with no endpoints gracefully', async () => {
      const emptySector = {
        name: 'empty',
        endpoints: []
      };
      
      const result = await routerGenerator.generateRouter([emptySector]);
      expect(result).toBeDefined();
      
      // Check that router file was created even with empty sector
      const outputDir = path.resolve(basePath, testConfig.generation.outputDir);
      const routerPath = path.join(outputDir, 'router.ts');
      
      const routerExists = await fs.access(routerPath).then(() => true).catch(() => false);
      expect(routerExists).toBe(true);
    });
  });
});
