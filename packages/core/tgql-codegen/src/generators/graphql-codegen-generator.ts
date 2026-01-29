import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TGQLCodegenConfig } from '../types/config.js';

export class GraphQLCodeGenGenerator {
  constructor(private config: TGQLCodegenConfig) {}

  async generateTypes(): Promise<void> {
    console.log('🔧 Generating GraphQL types using graphql-codegen...');
    
    try {
      // Ensure output directory exists
      await mkdir(this.config.graphqlCodegen.outputDir, { recursive: true });
      
      // Create graphql-codegen configuration
      const codegenConfig = this.createCodegenConfig();
      const configPath = join(this.config.graphqlCodegen.outputDir, 'codegen.yml');
      await writeFile(configPath, codegenConfig, 'utf-8');
      
      // Run graphql-codegen
      await this.runCodegen(configPath);
      
      console.log('✅ GraphQL types generated successfully!');
    } catch (error) {
      console.error('❌ GraphQL type generation failed:', error);
      throw error;
    }
  }

  private createCodegenConfig(): string {
    const config = this.config.graphqlCodegen;
    
    return `overwrite: true
schema: "${config.schemaPath}"
generates:
  ${config.outputDir}/index.ts:
    plugins:
      - typescript
      - typescript-operations
    config:
      scalars:
        ID: string
        DateTime: Date
      avoidOptionals:
        field: true
        inputValue: false
        object: false
      useTypeImports: true
      enumsAsTypes: true
      skipTypename: false
      nonOptionalTypename: false
      dedupeFragments: true
      inlineFragmentTypes: inline
      extractAllFieldsToTypes: false
      printFieldsOnNewLines: false
      includeExternalFragments: true
`;
  }

  private async runCodegen(configPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use the correct graphql-codegen command syntax with --config
      const childProcess = spawn('npx', ['graphql-codegen', '--config', configPath], {
        stdio: 'pipe',
        cwd: process.cwd()
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code: number | null) => {
        if (code === 0) {
          console.log('📊 GraphQL CodeGen output:', stdout);
          resolve();
        } else {
          console.error('❌ GraphQL CodeGen failed:', stderr);
          reject(new Error(`GraphQL CodeGen failed with code ${code}: ${stderr}`));
        }
      });

      childProcess.on('error', (error: Error) => {
        reject(new Error(`Failed to start GraphQL CodeGen: ${error.message}`));
      });
    });
  }
} 