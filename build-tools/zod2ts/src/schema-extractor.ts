import { resolve } from 'node:path';
import { z } from 'zod';
import { SchemaInfo, ExtractionResult, NoSchemasFoundError, InvalidSchemaError } from './types.js';
import { writeTypeFile, generateOutputPath } from './file-utils.js';
import { ZodSchemaLoader } from './zod-loader.js';
import { TypeGenerator } from './type-generator.js';

export class SchemaExtractor {
  constructor(
    private zodLoader: ZodSchemaLoader,
    private typeGenerator: TypeGenerator
  ) {}

  public async extractSchemas(
    zodPath: string,
    outputDir: string,
    typeNameOverride?: string
  ): Promise<ExtractionResult> {
    const resolvedPath = resolve(zodPath);

    // Load all Zod schemas from the file
    const zodSchemas = await this.zodLoader.loadSchemasFromFile(resolvedPath);

    // Get all Zod schemas (no longer filtering by 'Schema' suffix)
    const schemaEntries = Array.from(zodSchemas.entries());

    if (schemaEntries.length === 0) {
      throw new NoSchemasFoundError(zodPath);
    }

    const schemas: SchemaInfo[] = [];
    const outputFiles: string[] = [];

    const usedTypeNames = new Set<string>();

    for (const [schemaName, zodSchema] of schemaEntries) {
      let typeName: string;

      if (typeNameOverride) {
        // Use the override if provided
        typeName = typeNameOverride;
      } else if (schemaName.endsWith('Schema')) {
        // Remove 'Schema' suffix if it exists
        typeName = schemaName.replace(/Schema$/, '');
      } else {
        // Use the schema name as-is if it doesn't end with 'Schema'
        typeName = schemaName;
      }

      // Handle naming conflicts by appending a number
      let finalTypeName = typeName;
      let counter = 1;
      while (usedTypeNames.has(finalTypeName)) {
        finalTypeName = `${typeName}${counter}`;
        counter++;
      }
      usedTypeNames.add(finalTypeName);

      try {
        // Generate TypeScript type using the type generator
        const typeDefinition = this.typeGenerator.generateType(zodSchema, finalTypeName);

        // Write the type to a file
        const outputPath = generateOutputPath(outputDir, finalTypeName);
        writeTypeFile(outputPath, finalTypeName, typeDefinition);

        schemas.push({
          name: schemaName,
          typeName: finalTypeName,
          resolvedType: typeDefinition,
        });
        outputFiles.push(outputPath);
      } catch (error) {
        console.error(`Error processing schema ${schemaName}:`, error);
        throw new InvalidSchemaError(schemaName);
      }
    }

    return { schemas, outputFiles };
  }
}
