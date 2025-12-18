import fs from 'fs/promises';
import path from 'path';
import type { SectorInfo } from '../types/sector.js';
import type { TRPCCodegenConfig } from '../types/config.js';

export class SchemaGenerator {
  constructor(private config: TRPCCodegenConfig, private basePath: string) {}

  async generateSchemas(sectorInfos: SectorInfo[]): Promise<string[]> {

    const sectorsDir = path.resolve(this.basePath, this.config.source.sectorsDir);
    const outputSchemasDir = path.resolve(this.basePath, this.config.generation.outputDir, 'schemas');

    // Ensure output directory exists
    await fs.mkdir(outputSchemasDir, { recursive: true });

    const generatedFiles: string[] = [];

    // Check if there's a dist folder with compiled JavaScript files
    // Look for dist folder relative to where the sectors directory is located
    const projectRoot = path.dirname(sectorsDir); // Go up from src/sectors to project root
    const distDir = path.join(projectRoot, 'dist/sectors');
    const hasDistFolder = await fs.access(distDir).then(() => true).catch(() => false);

    // Copy schema files from each sector
    for (const sector of sectorInfos) {
        // Use the configured schema pattern to find the schema file
        const schemaPattern = this.config.source.schemaPattern
          .replace(/\*/g, sector.name);

        let sourceSchemaFile: string;
        let targetSchemaFile: string;

        if (hasDistFolder) {
          // Use compiled JavaScript from dist folder
          const jsSchemaPattern = schemaPattern.replace('.ts', '.js');
          sourceSchemaFile = path.join(distDir, jsSchemaPattern);
          targetSchemaFile = path.join(outputSchemasDir, `${sector.name}-schemas.js`);

          // Also copy source map if it exists
          const sourceMapFile = sourceSchemaFile + '.map';
          const targetMapFile = targetSchemaFile + '.map';
          try {
            const mapContent = await fs.readFile(sourceMapFile, 'utf-8');
            await fs.writeFile(targetMapFile, mapContent);
            generatedFiles.push(targetMapFile);
          } catch {
            // Source map is optional, ignore if not found
          }
        } else {
          // Fallback to TypeScript source (for backward compatibility)
          sourceSchemaFile = path.join(sectorsDir, schemaPattern);
          targetSchemaFile = path.join(outputSchemasDir, `${sector.name}-schemas.ts`);
        }

        try {
          const schemaContent = await fs.readFile(sourceSchemaFile, 'utf-8');
          await fs.writeFile(targetSchemaFile, schemaContent);
          generatedFiles.push(targetSchemaFile);
        } catch (error) {
        }
      }

    // Generate index file for schemas
    const indexPath = await this.generateSchemasIndex(sectorInfos, outputSchemasDir);
    generatedFiles.push(indexPath);

    return generatedFiles;
  }

  private async generateSchemasIndex(sectorInfos: SectorInfo[], outputSchemasDir: string): Promise<string> {
    // Check if we're outputting JavaScript or TypeScript
    const files = await fs.readdir(outputSchemasDir);
    const hasJsFiles = files.some(f => f.endsWith('-schemas.js'));
    const indexPath = path.join(outputSchemasDir, hasJsFiles ? 'index.js' : 'index.ts');

    // Generate re-exports for all schemas
    const exports = sectorInfos.map(sector =>
      `export * from './${sector.name}-schemas.js';`
    ).join('\n');

    const indexContent = `// Auto-generated - do not edit
// This file re-exports all schemas from sectors
${exports}
`;

    await fs.writeFile(indexPath, indexContent);
    return indexPath;
  }
}