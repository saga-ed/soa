import path from 'path';
import type { TRPCCodegenConfig } from '../types/config.js';
import type { GenerationResult } from '../types/sector.js';
import { SectorParser } from '../parsers/sector-parser.js';
import { RouterGenerator } from './router-generator.js';
import { SchemaGenerator } from './schema-generator.js';
import { Zod2tsGenerator } from './zod2ts-generator.js';

export class TRPCCodegen {
  private sectorParser: SectorParser;
  private routerGenerator: RouterGenerator;
  private schemaGenerator: SchemaGenerator;
  private zod2tsGenerator: Zod2tsGenerator;
  private debug: boolean;

  constructor(private config: TRPCCodegenConfig, private basePath: string, debug: boolean = false) {
    this.debug = debug;
    this.sectorParser = new SectorParser(config, basePath);
    this.routerGenerator = new RouterGenerator(config, basePath);
    this.schemaGenerator = new SchemaGenerator(config, basePath);
    this.zod2tsGenerator = new Zod2tsGenerator(config, basePath);
  }

  private log(message: string): void {
    if (this.debug) {
      console.log(message);
    }
  }

  async generate(): Promise<GenerationResult> {
    this.log('🚀 Starting tRPC code generation...');
    
    const errors: string[] = [];
    const generatedFiles: string[] = [];

    try {
      // Step 1: Discover and parse sectors
      this.log('🔍 Analyzing sector routers...');
      const sectors = await this.sectorParser.discoverSectors();

      // Step 2: Generate schemas
      try {
        const schemaFiles = await this.schemaGenerator.generateSchemas(sectors);
        generatedFiles.push(...schemaFiles);
      } catch (error) {
        const errorMsg = `Schema generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`❌ ${errorMsg}`);
        errors.push(errorMsg);
      }

      // Step 3: Generate router
      try {
        const routerFile = await this.routerGenerator.generateRouter(sectors);
        generatedFiles.push(routerFile);
      } catch (error) {
        const errorMsg = `Router generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`❌ ${errorMsg}`);
        errors.push(errorMsg);
      }

      // Step 4: Generate TypeScript types from Zod schemas
      try {
        const typesFiles = await this.zod2tsGenerator.generateTypes(sectors);
        generatedFiles.push(...typesFiles);
      } catch (error) {
        const errorMsg = `TypeScript types generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`❌ ${errorMsg}`);
        errors.push(errorMsg);
      }

      // Step 5: Generate package index
      try {
        const indexFile = await this.generatePackageIndex();
        generatedFiles.push(indexFile);
      } catch (error) {
        const errorMsg = `Index generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`❌ ${errorMsg}`);
        errors.push(errorMsg);
      }

      if (errors.length === 0) {
      } else {
      }

      return {
        sectors,
        generatedFiles,
        errors
      };

    } catch (error) {
      const errorMsg = `Code generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`❌ ${errorMsg}`);
      return {
        sectors: [],
        generatedFiles,
        errors: [errorMsg]
      };
    }
  }

  async dryRun(): Promise<void> {
    // Dry run functionality removed - use --debug flag for detailed output
  }

  private async generatePackageIndex(): Promise<string> {
    const { writeFile, mkdir } = await import('fs/promises');
    const outputPath = path.resolve(this.basePath, this.config.generation.outputDir);
    const indexPath = path.join(outputPath, 'index.ts');

    await mkdir(outputPath, { recursive: true });

    const indexContent = `// Auto-generated - do not edit
// Main exports for ${this.config.generation.packageName}
export * from './router.js';
export * from './schemas/index.js';
${this.config.zod2ts.enabled ? `export * from './types/index.js';` : ''}
`;

    await writeFile(indexPath, indexContent);
    return indexPath;
  }
}