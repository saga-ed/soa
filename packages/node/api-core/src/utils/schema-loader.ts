import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

export interface SchemaFile {
    path: string;
    content: string;
}

/**
 * Load a single GraphQL schema file
 */
export async function loadSchemaFile(filePath: string): Promise<SchemaFile> {
    const content = await readFile(filePath, 'utf-8');
    return {
        path: filePath,
        content,
    };
}

/**
 * Load multiple GraphQL schema files using glob patterns
 */
export async function loadSchemaFiles(patterns: string | string[]): Promise<SchemaFile[]> {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];
    const allFiles: string[] = [];

    for (const pattern of patternArray) {
        const files = await glob(pattern, {
            absolute: true,
            nodir: true,
        });
        allFiles.push(...files);
    }

    // Remove duplicates
    const uniqueFiles = Array.from(new Set(allFiles));

    // Load all files
    const schemaFiles = await Promise.all(uniqueFiles.map((file) => loadSchemaFile(file)));

    return schemaFiles;
}

/**
 * Concatenate multiple schema files into a single SDL string
 */
export function concatenateSchemas(schemaFiles: SchemaFile[]): string {
    return schemaFiles.map((file) => file.content.trim()).join('\n\n');
}

/**
 * Load and concatenate GraphQL schema files from glob patterns
 */
export async function loadAndMergeSchemas(patterns: string | string[]): Promise<string> {
    const schemaFiles = await loadSchemaFiles(patterns);

    if (schemaFiles.length === 0) {
        throw new Error(`No schema files found matching patterns: ${JSON.stringify(patterns)}`);
    }

    return concatenateSchemas(schemaFiles);
}

/**
 * Resolve glob patterns relative to a base directory
 */
export function resolveSchemaPatterns(
    baseDir: string,
    patterns: string | string[]
): string[] {
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];
    return patternArray.map((pattern) => join(baseDir, pattern));
}
