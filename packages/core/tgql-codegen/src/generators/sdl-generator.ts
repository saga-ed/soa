import { buildSchema } from 'type-graphql';
import { printSchema } from 'graphql';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { TGQLCodegenConfig } from '../types/config.js';

export class SDLGenerator {
  constructor(private config: TGQLCodegenConfig) {}

  /**
   * Emit SDL for a single unified schema
   */
  async emitSDL(resolverClasses: Function[], outputPath: string): Promise<void> {
    try {
      console.log(`🔍 Building unified schema with ${resolverClasses.length} resolver(s)...`);

      // Build schema with all resolvers
      const schema = await buildSchema({
        resolvers: resolverClasses as unknown as [Function, ...Function[]],
        validate: false,
      });

      // Convert to SDL
      const sdl = printSchema(schema);

      // Ensure output directory exists
      const outputDir = dirname(outputPath);
      await mkdir(outputDir, { recursive: true });

      // Write SDL file
      await writeFile(outputPath, sdl, 'utf-8');

      console.log(`✅ Emitted unified SDL to ${outputPath}`);
      console.log(`📊 Schema size: ${sdl.length} characters`);
    } catch (error) {
      console.error('❌ Failed to emit unified SDL:', error);
      throw error;
    }
  }

  /**
   * Emit SDL for each sector separately
   */
  async emitSectorSDL(
    sectorGroups: Map<string, Function[]>,
    outputDir: string
  ): Promise<void> {
    try {
      console.log(`🔍 Emitting sector schemas to ${outputDir}...`);

      // Ensure output directory exists
      await mkdir(outputDir, { recursive: true });

      // Emit SDL for each sector
      for (const [sectorName, resolvers] of sectorGroups) {
        const fileName = `${sectorName}.graphql`;
        const outputPath = join(outputDir, fileName);

        await this.emitSingleSectorSDL(sectorName, resolvers, outputPath);
      }

      console.log(`✅ Successfully emitted ${sectorGroups.size} sector schema file(s) to ${outputDir}`);
    } catch (error) {
      console.error('❌ Failed to emit sector schemas:', error);
      throw error;
    }
  }

  /**
   * Emit SDL for a specific sector containing multiple resolvers
   */
  private async emitSingleSectorSDL(
    sectorName: string,
    resolvers: Function[],
    outputPath: string
  ): Promise<void> {
    try {
      // Build schema with all resolvers in this sector
      const schema = await buildSchema({
        resolvers: resolvers as unknown as [Function, ...Function[]],
        validate: false, // Skip validation for sector-level emission
      });

      // Convert to SDL
      const sdl = printSchema(schema);

      // Ensure output directory exists
      const outputDir = dirname(outputPath);
      await mkdir(outputDir, { recursive: true });

      // Write SDL file
      await writeFile(outputPath, sdl, 'utf-8');

      console.log(`✅ Emitted SDL for sector '${sectorName}' to ${outputPath}`);
      console.log(`📊 Schema size: ${sdl.length} characters`);
    } catch (error) {
      console.error(`❌ Failed to emit SDL for sector '${sectorName}':`, error);
      throw error;
    }
  }

  /**
   * Group resolvers by sector name
   */
  groupResolversBySector(resolvers: Array<{ sectorName: string; constructor: Function }>): Map<string, Function[]> {
    const sectorGroups = new Map<string, Function[]>();

    for (const resolver of resolvers) {
      const sectorName = resolver.sectorName;
      if (!sectorGroups.has(sectorName)) {
        sectorGroups.set(sectorName, []);
      }
      sectorGroups.get(sectorName)!.push(resolver.constructor);
    }

    return sectorGroups;
  }
} 