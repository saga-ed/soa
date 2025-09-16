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

    // First, handle multi-line export const declarations
    // This regex captures the entire declaration including multi-line objects
    transformed = transformed.replace(
      /export\s+const\s+(\w+)\s*=\s*([\s\S]*?)(?=\n(?:export|\/\/|$))/g,
      (match, name, value) => {
        // Check if the value ends with a semicolon, if not add one
        const trimmedValue = value.trimEnd();
        const needsSemicolon = !trimmedValue.endsWith(';');
        const cleanValue = needsSemicolon ? trimmedValue + ';' : trimmedValue;
        return `const ${name} = ${cleanValue}\nexports.${name} = ${name};`;
      }
    );

    // Handle: export type declarations (just remove them as they're TypeScript only)
    transformed = transformed.replace(
      /export\s+type\s+\w+\s*=\s*[^;]+;/g,
      ''
    );

    // Handle: export { SomeSchema };
    transformed = transformed.replace(
      /export\s*{\s*([^}]+)\s*};?/g,
      (match, exports) => {
        const exportNames = exports.split(',').map((name: string) => name.trim());
        return exportNames.map((name: string) => `exports.${name} = ${name};`).join('\n');
      }
    );

    // Remove any remaining import statements that might interfere
    transformed = transformed.replace(
      /import\s+.*?from\s+['"][^'"]+['"];?/g,
      ''
    );

    return transformed;
  }

  private isZodSchema(value: any): value is z.ZodSchema {
    return value && typeof value === 'object' && '_def' in value;
  }
}
