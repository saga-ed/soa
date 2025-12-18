import { promises as fs } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import * as ts from 'typescript';
import { Logger } from './logger.js';

export interface TranspilationResult {
  jsFilePath: string;
  cleanup: () => Promise<void>;
}

export class Transpiler {
  private tempDirs: string[] = [];

  constructor() {
    // Register cleanup on process exit
    process.on('exit', () => this.cleanupSync());
    process.on('SIGINT', () => this.cleanup().then(() => process.exit(0)));
    process.on('SIGTERM', () => this.cleanup().then(() => process.exit(0)));
  }

  async transpileFile(tsFilePath: string): Promise<TranspilationResult> {
    if (!tsFilePath.endsWith('.ts')) {
      throw new Error(`Expected TypeScript file, got: ${tsFilePath}`);
    }

    // Create temporary directory
    const tempDir = await mkdtemp(join(tmpdir(), 'zod2ts-'));
    this.tempDirs.push(tempDir);

    Logger.info(`Created temporary directory: ${tempDir}`);

    try {
      // Read the TypeScript file
      const tsContent = await fs.readFile(tsFilePath, 'utf-8');

      // Transpile using TypeScript compiler
      Logger.command('Transpiling TypeScript to CommonJS JavaScript');

      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        skipLibCheck: true,
        declaration: false,
        sourceMap: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      };

      const result = ts.transpileModule(tsContent, {
        compilerOptions,
        moduleName: basename(tsFilePath, extname(tsFilePath))
      });

      if (result.diagnostics && result.diagnostics.length > 0) {
        const errors = result.diagnostics.map(d => d.messageText).join('\n');
        throw new Error(`TypeScript compilation errors:\n${errors}`);
      }

      // Write transpiled JavaScript to temp directory
      const jsFileName = basename(tsFilePath, '.ts') + '.js';
      const jsFilePath = join(tempDir, jsFileName);

      await fs.writeFile(jsFilePath, result.outputText);

      Logger.success(`Transpiled ${tsFilePath} → ${jsFilePath}`);

      return {
        jsFilePath,
        cleanup: async () => {
          await this.cleanupTempDir(tempDir);
        }
      };

    } catch (error) {
      // Clean up temp dir on error
      await this.cleanupTempDir(tempDir);
      throw error;
    }
  }

  private async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      this.tempDirs = this.tempDirs.filter(dir => dir !== tempDir);
      Logger.cleanup(`Removed temporary directory: ${tempDir}`);
    } catch (error) {
      Logger.error(`Failed to cleanup ${tempDir}: ${error}`);
    }
  }

  async cleanup(): Promise<void> {
    Logger.cleanup('Cleaning up temporary directories...');
    await Promise.all(this.tempDirs.map(dir => this.cleanupTempDir(dir)));
  }

  private cleanupSync(): void {
    // Synchronous cleanup for process exit
    this.tempDirs.forEach(dir => {
      try {
        require('fs').rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore errors during sync cleanup
      }
    });
  }
}