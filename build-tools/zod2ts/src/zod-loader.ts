import { z } from 'zod';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SchemaLoadingError } from './types.js';

export class ZodSchemaLoader {
  constructor() {
    // Inject our bundled zod into global scope for schema files to use
    this.setupGlobalZod();
  }

  async loadSchemasFromFile(filePath: string): Promise<Map<string, z.ZodSchema>> {
    try {
      const resolvedPath = resolve(filePath);

      // Read and modify the schema file content instead of dynamic import
      const originalContent = await readFile(resolvedPath, 'utf-8');
      const modifiedContent = this.replaceZodImports(originalContent);

      // Create a module-like environment and evaluate the modified content
      const moduleExports = {};
      
      // Transform ES module exports to work in function scope
      const transformedContent = this.transformESModuleExports(modifiedContent);
      
      const moduleScope = {
        exports: moduleExports,
        module: { exports: moduleExports },
        require: (id: string) => {
          if (id === 'zod') {
            return { z };
          }
          throw new Error(`Module not found: ${id}`);
        },
        __dirname: resolve(filePath, '..'),
        __filename: resolvedPath,
        console,
        global: globalThis,
        process,
      };

      // Evaluate the transformed content in the module scope
      const func = new Function(...Object.keys(moduleScope), transformedContent + '\n; return exports;');
      const module = func(...Object.values(moduleScope));

      const schemas = new Map<string, z.ZodSchema>();

      // Extract Zod schemas from module exports
      for (const [name, export_] of Object.entries(module)) {
        if (this.isZodSchema(export_)) {
          schemas.set(name, export_);
        }
      }

      return schemas;
    } catch (error) {
      throw new SchemaLoadingError(
        `Failed to load schemas from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private setupGlobalZod(): void {
    // Make bundled zod available globally
    (globalThis as any).__bundledZod = { z };
  }

  private replaceZodImports(content: string): string {
    // Replace various zod import patterns with our bundled version
    let modified = content;

    // Handle: import { z } from 'zod';
    modified = modified.replace(
      /import\s*{\s*z\s*}\s*from\s*['"]zod['"];?/g,
      'const { z } = globalThis.__bundledZod;'
    );

    // Handle: import * as z from 'zod';
    modified = modified.replace(
      /import\s*\*\s*as\s+z\s*from\s*['"]zod['"];?/g,
      'const z = globalThis.__bundledZod;'
    );

    // Handle: import z from 'zod';
    modified = modified.replace(
      /import\s+z\s*from\s*['"]zod['"];?/g,
      'const z = globalThis.__bundledZod;'
    );

    // Handle CommonJS: const { z } = require('zod');
    modified = modified.replace(
      /const\s*{\s*z\s*}\s*=\s*require\s*\(\s*['"]zod['"]\s*\);?/g,
      'const { z } = globalThis.__bundledZod;'
    );

    return modified;
  }

  private transformESModuleExports(content: string): string {
    // Transform ES module exports to CommonJS-style assignments
    let transformed = content;

    // Handle: export const SomeSchema = z.object(...);
    transformed = transformed.replace(
      /export\s+const\s+(\w+)\s*=/g,
      'const $1 =; exports.$1 = $1; exports.$1'
    );

    // Fix the double assignment issue from the replacement above
    transformed = transformed.replace(
      /const\s+(\w+)\s*=;\s*exports\.\1\s*=\s*\1;\s*exports\.\1\s*=/g,
      'const $1 =; exports.$1 = $1; $1'
    );

    // Actually, let's do this more cleanly
    transformed = content;
    
    // Replace export const with const + assignment
    transformed = transformed.replace(
      /export\s+const\s+(\w+)\s*=\s*([^;]+);?/g,
      'const $1 = $2;\nexports.$1 = $1;'
    );

    // Handle: export { SomeSchema };
    transformed = transformed.replace(
      /export\s*{\s*([^}]+)\s*};?/g,
      (match, exports) => {
        const exportNames = exports.split(',').map((name: string) => name.trim());
        return exportNames.map((name: string) => `exports.${name} = ${name};`).join('\n');
      }
    );

    return transformed;
  }

  private isZodSchema(value: any): value is z.ZodSchema {
    return value && typeof value === 'object' && '_def' in value;
  }
}
