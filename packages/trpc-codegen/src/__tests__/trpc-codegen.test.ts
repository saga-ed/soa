import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { TRPCCodegen } from '../generators/codegen.js';
import { ConfigLoader } from '../utils/config-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('TRPCCodegen', () => {
  let codegen: TRPCCodegen;
  let testConfig: any;
  let basePath: string;
  let outputDir: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root
    
    // Create unique temporary directory for this test
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-codegen-test-'));
    
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

  describe('generate()', () => {
    it('should discover and process test sectors correctly', async () => {
      const result = await codegen.generate();
      
      expect(result.errors).toHaveLength(0);
      expect(result.sectors).toHaveLength(2); // Both example sectors
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      
      // Check that all sectors were discovered
      const sectorNames = result.sectors.map(s => s.name).sort();
      expect(sectorNames).toEqual(['example_sector1', 'example_sector2']);
    });

    it('should generate the expected number of endpoints', async () => {
      const result = await codegen.generate();
      
      // example_sector1: 6 endpoints (including healthCheck)
      // example_sector2: 5 endpoints
      const totalEndpoints = result.sectors.reduce((sum, s) => sum + s.endpoints.length, 0);
      expect(totalEndpoints).toBe(11); // 6+5 endpoints from both test sectors
    });

    it('should generate files in the correct output directory', async () => {
      const result = await codegen.generate();
      
      // Check that output directory exists
      const outputExists = await fs.access(outputDir).then(() => true).catch(() => false);
      expect(outputExists).toBe(true);
      
      // Check that expected files were generated
      const expectedFiles = [
        'index.ts',
        'router.ts',
        'schemas/index.ts',
        'schemas/example_sector1-schemas.ts',
        'schemas/example_sector2-schemas.ts'
      ];

      // Add type files only if zod2ts is enabled
      if (testConfig.zod2ts?.enabled) {
        expectedFiles.push(
          'types/index.ts',
          'types/example_sector1/index.ts',
          'types/example_sector2/index.ts'
        );
      }
      
      for (const file of expectedFiles) {
        const filePath = path.join(outputDir, file);
        const exists = await fs.access(filePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should generate router with correct structure', async () => {
      await codegen.generate();
      
      const routerPath = path.join(outputDir, 'router.ts');
      const routerContent = await fs.readFile(routerPath, 'utf-8');
      
      // Check that router imports both sector schemas
      expect(routerContent).toContain("import * as example_sector1Schemas from './schemas/example_sector1-schemas.js';");
      expect(routerContent).toContain("import * as example_sector2Schemas from './schemas/example_sector2-schemas.js';");

      // Check that router has both sectors
      expect(routerContent).toContain('example_sector1: t.router({');
      expect(routerContent).toContain('example_sector2: t.router({');

      // Check that endpoints are included
      expect(routerContent).toContain('getItem: t.procedure');
      expect(routerContent).toContain('createResource: t.procedure');
    });

    it('should generate schemas index with correct exports', async () => {
      await codegen.generate();
      
      const schemasIndexPath = path.join(outputDir, 'schemas/index.ts');
      const schemasIndexContent = await fs.readFile(schemasIndexPath, 'utf-8');
      
      expect(schemasIndexContent).toContain("export * from './example_sector1-schemas.js';");
      expect(schemasIndexContent).toContain("export * from './example_sector2-schemas.js';");
    });

    it('should generate types index with correct exports', async () => {
      await codegen.generate();
      
      // Only check types if zod2ts is enabled
      if (testConfig.zod2ts?.enabled) {
        const typesIndexPath = path.join(outputDir, 'types/index.ts');
        const typesIndexContent = await fs.readFile(typesIndexPath, 'utf-8');
        
        expect(typesIndexContent).toContain("export * from './example_sector1/index.js';");
        expect(typesIndexContent).toContain("export * from './example_sector2/index.js';");
      } else {
        // Skip this test when zod2ts is disabled
        expect(true).toBe(true);
      }
    });

    it('should generate main index with correct exports', async () => {
      await codegen.generate();
      
      const mainIndexPath = path.join(outputDir, 'index.ts');
      const mainIndexContent = await fs.readFile(mainIndexPath, 'utf-8');
      
      expect(mainIndexContent).toContain("export * from './router.js';");
      expect(mainIndexContent).toContain("export * from './schemas/index.js';");
      
      // Only check types export if zod2ts is enabled
      if (testConfig.zod2ts?.enabled) {
        expect(mainIndexContent).toContain("export * from './types/index.js';");
      }
    });
  });

  describe('error handling', () => {
    it('should handle missing sectors gracefully', async () => {
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
    });
  });

});
