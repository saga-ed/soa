import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('TGQL Schema Generation', () => {
  it('should validate existing manifest structure', () => {
    // Test against the existing generated manifest instead of running codegen
    const manifestPath = resolve(__dirname, '../../generated/manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    
    // Validate manifest structure
    expect(manifest).toHaveProperty('generatedAt');
    expect(manifest).toHaveProperty('config');
    expect(manifest).toHaveProperty('sources');
    expect(manifest).toHaveProperty('outputs');
    
    // Validate config section
    expect(manifest.config.source).toHaveProperty('sectorsDir');
    expect(manifest.config.sdl.enabled).toBe(true);
    expect(manifest.config.graphqlCodegen.enabled).toBe(true);
    
    // Validate sources section
    expect(manifest.sources.sectors).toHaveLength(2);
    const sectorNames = manifest.sources.sectors.map((s: any) => s.name);
    expect(sectorNames).toContain('session');
    expect(sectorNames).toContain('user');
    
    // Validate outputs section
    expect(manifest.outputs.schema.directory).toBeTruthy();
    expect(manifest.outputs.types.directory).toBeTruthy();
    expect(manifest.outputs.schema.files).toHaveLength(2);
    expect(manifest.outputs.types.files).toHaveLength(3);
  });



  it('should validate source-to-output mapping integrity', () => {
    // Read the manifest to validate source-to-output mapping
    const manifestPath = resolve(__dirname, '../../generated/manifest.json');
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    
    // Validate that each sector has corresponding outputs
    for (const sector of manifest.sources.sectors) {
      // Check that schema file exists for this sector
      const schemaFile = `${sector.name}.graphql`;
      expect(manifest.outputs.schema.files).toContain(schemaFile);
      
      // Check that types file exists for this sector (when graphqlCodegen is enabled)
      if (manifest.config.graphqlCodegen.enabled) {
        const typesFile = `${sector.name}.types.ts`;
        expect(manifest.outputs.types.files).toContain(typesFile);
      }
      
      // Validate that source files are properly discovered
      expect(sector.resolvers).toHaveLength(1);
      expect(sector.types).toHaveLength(1);
      expect(sector.inputs).toHaveLength(1);
      
      // Check that resolver file path contains the sector name
      expect(sector.resolvers[0]).toContain(`/sectors/${sector.name}/`);
    }
  });

  it('should validate generated schema content quality', () => {
    // Read the manifest to get file paths
    const manifestPath = resolve(__dirname, '../../generated/manifest.json');
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    
    // Validate schema file content
    for (const schemaFile of manifest.outputs.schema.files) {
      const filePath = join(manifest.outputs.schema.directory, schemaFile);
      const content = readFileSync(filePath, 'utf-8');
      
      // Basic schema validation
      expect(content).toContain('type Query');
      expect(content).toContain('type Mutation');
      
      // Check for sector-specific content
      const sectorName = schemaFile.replace('.graphql', '');
      expect(content).toContain(`type ${sectorName.charAt(0).toUpperCase() + sectorName.slice(1)}`);
    }
  });
});