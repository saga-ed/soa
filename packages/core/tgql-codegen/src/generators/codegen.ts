import type { TGQLCodegenConfig } from '../types/config.js';
import type { GenerationResult, CodegenManifest } from '../types/sector.js';
import { SectorParser } from '../parsers/sector-parser.js';
import { ResolverParser } from '../parsers/resolver-parser.js';
import { TypeParser } from '../parsers/type-parser.js';
import { SDLGenerator } from './sdl-generator.js';
import { GraphQLCodeGenGenerator } from './graphql-codegen-generator.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class TGQLCodegen {
  private sectorParser: SectorParser;
  private sdlGenerator: SDLGenerator;
  private graphqlCodegenGenerator: GraphQLCodeGenGenerator;

  constructor(private config: TGQLCodegenConfig) {
    const resolverParser = new ResolverParser(config);
    const typeParser = new TypeParser(config);
    
    this.sectorParser = new SectorParser(config, resolverParser, typeParser);
    this.sdlGenerator = new SDLGenerator(config);
    this.graphqlCodegenGenerator = new GraphQLCodeGenGenerator(config);
  }

  async generate(): Promise<GenerationResult> {
    console.log('🚀 Starting TypeGraphQL code generation...');
    
    try {
      // Parse all sectors
      const sectors = await this.sectorParser.parseSectors();
      
      if (sectors.length === 0) {
        console.warn('⚠️  No sectors found with GraphQL resolvers');
        throw new Error('No sectors found with GraphQL resolvers');
      }

      console.log(`📊 Found ${sectors.length} sectors with GraphQL definitions`);
      
      // Phase 1: Generate SDL files
      if (this.config.sdl.enabled) {
        await this.generateSDL(sectors);
      }
      
      // Phase 2: Generate TypeScript types from SDL
      if (this.config.graphqlCodegen.enabled) {
        await this.graphqlCodegenGenerator.generateTypes();
      }
      
      console.log('✅ Code generation completed successfully!');
      
      // Generate manifest
      await this.generateManifest(sectors);
      
      // Build the actual file paths based on what was generated
      const schemaFile = this.config.sdl.enabled 
        ? this.config.sdl.emitBySector 
          ? `${this.config.sdl.outputDir}/schema` // Directory containing sector files
          : `${this.config.sdl.outputDir}/${this.config.sdl.fileName || 'schema.graphql'}` // Single schema file
        : '';

      const typeFiles = this.config.graphqlCodegen.enabled
        ? [`${this.config.graphqlCodegen.outputDir}/index.ts`] // Main types file
        : [];

      return {
        schemaFile,
        typeFiles,
        sectorCount: sectors.length
      };
    } catch (error) {
      console.error('❌ Code generation failed:', error);
      throw error;
    }
  }

  async generateSDLOnly(): Promise<void> {
    console.log('🚀 Starting SDL-only generation...');
    
    try {
      // Parse all sectors
      const sectors = await this.sectorParser.parseSectors();
      
      if (sectors.length === 0) {
        console.warn('⚠️  No sectors found with GraphQL resolvers');
        throw new Error('No sectors found with GraphQL resolvers');
      }

      console.log(`📊 Found ${sectors.length} sectors with GraphQL definitions`);
      
      // Generate SDL
      await this.generateSDL(sectors);
      
      console.log('✅ SDL generation completed successfully!');
    } catch (error) {
      console.error('❌ SDL generation failed:', error);
      throw error;
    }
  }

  async generateTypesOnly(): Promise<void> {
    console.log('🚀 Starting types-only generation...');
    
    try {
      // Generate TypeScript types from SDL
      await this.graphqlCodegenGenerator.generateTypes();
      
      console.log('✅ Type generation completed successfully!');
    } catch (error) {
      console.error('❌ Type generation failed:', error);
      throw error;
    }
  }

  private async generateSDL(sectors: any[]): Promise<void> {
    // Extract resolver information from sectors
    const resolvers: Array<{ sectorName: string; constructor: Function }> = [];
    
    for (const sector of sectors) {
      for (const resolver of sector.resolvers) {
        // We need to dynamically import the resolver class
        const resolverModule = await this.dynamicImport(resolver.filePath);
        const resolverClass = resolverModule[resolver.className];
        
        if (resolverClass) {
          resolvers.push({
            sectorName: sector.name,
            constructor: resolverClass
          });
        }
      }
    }

    if (this.config.sdl.emitBySector) {
      // Group resolvers by sector and emit separate files
      const sectorGroups = this.sdlGenerator.groupResolversBySector(resolvers);
      await this.sdlGenerator.emitSectorSDL(sectorGroups, this.config.sdl.outputDir);
    } else {
      // Emit single unified schema
      const resolverClasses = resolvers.map(r => r.constructor);
      const outputPath = `${this.config.sdl.outputDir}/${this.config.sdl.fileName}`;
      await this.sdlGenerator.emitSDL(resolverClasses, outputPath);
    }
  }

  private async generateManifest(sectors: any[]): Promise<void> {
    try {
      const manifest: CodegenManifest = {
        generatedAt: new Date().toISOString(),
        config: {
          source: {
            sectorsDir: this.config.source.sectorsDir,
            resolverPattern: this.config.source.resolverPattern,
            typePattern: this.config.source.typePattern,
            inputPattern: this.config.source.inputPattern,
          },
          generation: {
            outputDir: this.config.generation.outputDir,
            packageName: this.config.generation.packageName,
            schemaName: this.config.generation.schemaName,
          },
          sdl: {
            enabled: this.config.sdl.enabled,
            outputDir: this.config.sdl.outputDir,
            fileName: this.config.sdl.fileName,
            emitBySector: this.config.sdl.emitBySector,
          },
          graphqlCodegen: {
            enabled: this.config.graphqlCodegen.enabled,
            schemaPath: this.config.graphqlCodegen.schemaPath,
            outputDir: this.config.graphqlCodegen.outputDir,
            plugins: this.config.graphqlCodegen.plugins,
          },
        },
        sources: {
          sectors: sectors.map(sector => ({
            name: sector.name,
            resolvers: sector.resolvers.map((r: any) => r.filePath),
            types: sector.types.map((t: any) => t.filePath),
            inputs: sector.inputs.map((i: any) => i.filePath),
          })),
        },
        outputs: {
          schema: {
            directory: this.config.sdl.enabled ? this.config.sdl.outputDir : '',
            files: this.config.sdl.enabled && this.config.sdl.emitBySector 
              ? sectors.map(s => `${s.name}.graphql`)
              : this.config.sdl.fileName ? [this.config.sdl.fileName] : [],
          },
          types: {
            directory: this.config.graphqlCodegen.enabled ? this.config.graphqlCodegen.outputDir : '',
            files: this.config.graphqlCodegen.enabled 
              ? ['index.ts', ...sectors.map(s => `${s.name}.types.ts`)]
              : [],
          },
        },
      };

      const manifestPath = join(this.config.generation.outputDir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      console.log(`📋 Generated manifest at ${manifestPath}`);
    } catch (error) {
      console.error('❌ Failed to generate manifest:', error);
      // Don't throw - manifest generation failure shouldn't break the main process
    }
  }

  private async dynamicImport(filePath: string): Promise<any> {
    try {
      // Convert .ts to .js and look in dist directory
      const jsPath = filePath.replace(/\.ts$/, '.js').replace('/src/', '/dist/');
      return await import(jsPath);
    } catch (error) {
      console.error(`Failed to import resolver from ${filePath}:`, error);
      throw error;
    }
  }

  async watch(): Promise<void> {
    console.log('👀 Starting watch mode for TypeGraphQL codegen...');
    
    const chokidar = await import('chokidar');
    
    const patterns = [
      this.config.source.resolverPattern,
      this.config.source.typePattern,
      this.config.source.inputPattern
    ].map(pattern => `${this.config.source.sectorsDir}/${pattern}`);
    
    const watcher = chokidar.watch(patterns, {
      ignored: /node_modules|\.git/,
      persistent: true
    });
    
    const regenerate = async () => {
      try {
        console.log('\n🔄 Files changed, regenerating...');
        await this.generate();
        console.log('✅ Regeneration complete\n');
      } catch (error) {
        console.error('❌ Regeneration failed:', error);
      }
    };
    
    watcher
      .on('add', regenerate)
      .on('change', regenerate)
      .on('unlink', regenerate);
    
    console.log(`📂 Watching: ${patterns.join(', ')}`);
    console.log('Press Ctrl+C to stop watching');
    
    // Initial generation
    await regenerate();
  }
}