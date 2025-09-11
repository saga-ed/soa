import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import type { TRPCCodegenConfig } from '../types/config.js';
import type { SectorInfo } from '../types/sector.js';

export class Zod2tsGenerator {
  constructor(private config: TRPCCodegenConfig, private basePath: string) {}

  async generateTypes(sectorInfos: SectorInfo[]): Promise<string[]> {
    if (!this.config.zod2ts.enabled) {
      return [];
    }

    
    const outputPath = path.resolve(this.basePath, this.config.generation.outputDir);
    const typesOutputDir = path.join(outputPath, this.config.zod2ts.outputDir);
    
    // Ensure types output directory exists
    await fs.mkdir(typesOutputDir, { recursive: true });
    
    const generatedFiles: string[] = [];
    
    try {
      // Process each sector's schema file
      for (const sector of sectorInfos) {
        const schemaFilePath = path.join(outputPath, 'schemas', `${sector.name}-schemas.ts`);
        
        // Check if schema file exists
        try {
          await fs.access(schemaFilePath);
        } catch (error) {
          continue;
        }
        
        const sectorTypesDir = path.join(typesOutputDir, sector.name);
        await fs.mkdir(sectorTypesDir, { recursive: true });
        
        try {
          // Run zod2ts for this sector's schema file
          const result = await this.runZod2ts(schemaFilePath, sectorTypesDir);
          if (result.success && result.files) {
            generatedFiles.push(...result.files);
            
            // Generate index file for this sector
            const sectorIndexPath = await this.generateSectorIndex(sector.name, sectorTypesDir, result.files);
            generatedFiles.push(sectorIndexPath);
            
          } else {
            console.error(`❌ Failed to generate types for sector ${sector.name}:`, result.error);
            // Still create an empty index file for consistency
            const sectorIndexPath = await this.generateSectorIndex(sector.name, sectorTypesDir, []);
            generatedFiles.push(sectorIndexPath);
          }
        } catch (error) {
          console.error(`❌ Error generating types for sector ${sector.name}:`, error);
          // Still create an empty index file for consistency
          const sectorIndexPath = await this.generateSectorIndex(sector.name, sectorTypesDir, []);
          generatedFiles.push(sectorIndexPath);
        }
      }
      
      // Generate types index file
      const typesIndexPath = await this.generateTypesIndex(sectorInfos, typesOutputDir);
      generatedFiles.push(typesIndexPath);
      
      return generatedFiles;
      
    } catch (error) {
      const errorMsg = `TypeScript types generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  private async runZod2ts(zodPath: string, outputDir: string): Promise<{ success: boolean; files?: string[]; error?: string }> {
    return new Promise(async (resolve) => {
      // Try to find zod2ts source in multiple possible locations
      const possibleSourcePaths = [
        path.resolve(this.basePath, '../../build-tools/zod2ts/src/index.ts'),  // For apps/api/types in saga-soa
        path.resolve(this.basePath, '../../../build-tools/zod2ts/src/index.ts'),  // For deeper nesting
        path.resolve(this.basePath, '../../../../build-tools/zod2ts/src/index.ts'),  // Alternative
        path.resolve(this.basePath, 'node_modules/@hipponot/zod2ts/src/index.ts'),  // Via node_modules link (saga-sm)
        path.resolve(this.basePath, '../node_modules/@hipponot/zod2ts/src/index.ts'),  // Via parent node_modules link
        '/home/skelly/dev/saga-soa/build-tools/zod2ts/src/index.ts',  // Absolute fallback
      ];
      
      let zod2tsPath: string | null = null;
      for (const testPath of possibleSourcePaths) {
        try {
          await fs.access(testPath);
          zod2tsPath = testPath;
          break;
        } catch {
          // Continue to next path
        }
      }
      
      if (!zod2tsPath) {
        resolve({ 
          success: false, 
          error: `Could not find zod2ts source. Tried paths: ${possibleSourcePaths.join(', ')}` 
        });
        return;
      }
      
      const args = [
        '--zod-path', zodPath,
        '--output-dir', outputDir
      ];
      
      // Use the zod2ts binary directly instead of tsx
      // Try multiple possible paths to find the zod2ts binary
      const possiblePaths = [
        path.resolve(this.basePath, '../../../build-tools/zod2ts/bin/zod2ts'),  // For apps/examples/trpc-api/trpc-types
        path.resolve(this.basePath, '../../../../build-tools/zod2ts/bin/zod2ts'),  // For deeper nesting
        path.resolve(this.basePath, '../../build-tools/zod2ts/bin/zod2ts'),  // Alternative
        path.resolve(this.basePath, 'node_modules/@hipponot/zod2ts/bin/zod2ts'),  // Via node_modules link (saga-sm)
        path.resolve(this.basePath, '../node_modules/@hipponot/zod2ts/bin/zod2ts'),  // Via parent node_modules link
        '/home/skelly/dev/saga-soa/build-tools/zod2ts/bin/zod2ts',  // Absolute fallback
      ];
      
      let zod2tsBinary: string | null = null;
      for (const testPath of possiblePaths) {
        try {
          await fs.access(testPath);
          zod2tsBinary = testPath;
          break;
        } catch {
          // Continue to next path
        }
      }
      
      if (!zod2tsBinary) {
        resolve({ 
          success: false, 
          error: `Could not find zod2ts binary. Tried paths: ${possiblePaths.join(', ')}` 
        });
        return;
      }
      
      const child = spawn('node', [zod2tsBinary, ...args], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', async (code) => {
        if (code === 0) {
          try {
            // List generated files
            const files = await this.listGeneratedFiles(outputDir);
            resolve({ success: true, files });
          } catch (error) {
            resolve({ success: true, files: [] });
          }
        } else {
          resolve({ 
            success: false, 
            error: stderr || stdout || `Process exited with code ${code}` 
          });
        }
      });
      
      child.on('error', (error) => {
        resolve({ 
          success: false, 
          error: `Failed to start zod2ts: ${error.message}` 
        });
      });
    });
  }

  private async listGeneratedFiles(directory: string): Promise<string[]> {
    try {
      const files = await fs.readdir(directory, { recursive: true });
      return files
        .filter(file => typeof file === 'string' && file.endsWith('.ts'))
        .map(file => path.join(directory, file));
    } catch (error) {
      return [];
    }
  }

  private async generateSectorIndex(sectorName: string, sectorTypesDir: string, generatedFiles: string[]): Promise<string> {
    const indexPath = path.join(sectorTypesDir, 'index.ts');
    
    // Get the relative paths of all generated TypeScript files in this directory
    const normalizedSectorDir = path.resolve(sectorTypesDir);
    const typeFiles = generatedFiles
      .filter(file => file.endsWith('.ts') && path.resolve(path.dirname(file)) === normalizedSectorDir)
      .map(file => path.basename(file, '.ts'))
      .filter(name => name !== 'index'); // Don't export the index file itself
    
    // Generate re-exports for all types in this sector
    const exports = typeFiles.map(typeName => 
      `export * from './${typeName}.js';`
    ).join('\n');
    
    const indexContent = `// Auto-generated - do not edit
// This file re-exports all TypeScript types for ${sectorName} sector
${exports}
`;
    
    await fs.writeFile(indexPath, indexContent);
    return indexPath;
  }

  private async generateTypesIndex(sectorInfos: SectorInfo[], typesOutputDir: string): Promise<string> {
    const indexPath = path.join(typesOutputDir, 'index.ts');
    
    // Generate re-exports for all sector types
    const exports = sectorInfos.map(sector => 
      `export * from './${sector.name}/index.js';`
    ).join('\n');
    
    const indexContent = `// Auto-generated - do not edit
// This file re-exports all TypeScript types from sectors
${exports}
`;
    
    await fs.writeFile(indexPath, indexContent);
    return indexPath;
  }
}
