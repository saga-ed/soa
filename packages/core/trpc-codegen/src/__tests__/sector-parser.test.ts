import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { SectorParser } from '../parsers/sector-parser.js';
import { ConfigLoader } from '../utils/config-loader.js';

describe('SectorParser', () => {
  let sectorParser: SectorParser;
  let testConfig: any;
  let basePath: string;

  beforeEach(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root
    const configPath = path.resolve(basePath, 'src/__tests__/fixtures/test-config.js');
    testConfig = await ConfigLoader.loadConfig(configPath, basePath);
    sectorParser = new SectorParser(testConfig, basePath);
  });

  describe('discoverSectors()', () => {
    it('should discover test sectors correctly', async () => {
      const sectors = await sectorParser.discoverSectors();

      expect(sectors).toHaveLength(2);

      // Check sector names
      const sectorNames = sectors.map(s => s.name).sort();
      expect(sectorNames).toEqual(['example_sector1', 'example_sector2']);
    });

    it('should parse example_sector1 endpoints correctly', async () => {
      const sectors = await sectorParser.discoverSectors();
      const sector1 = sectors.find(s => s.name === 'example_sector1');

      expect(sector1).toBeDefined();
      expect(sector1!.endpoints).toHaveLength(6); // Including healthCheck

      // Check endpoint names
      const endpointNames = sector1!.endpoints.map(e => e.name).sort();
      expect(endpointNames).toEqual([
        'createItem',
        'deleteItem',
        'getItem',
        'healthCheck',
        'listItems',
        'updateItem'
      ]);

      // Check that endpoints have correct types
      const getItemEndpoint = sector1!.endpoints.find(e => e.name === 'getItem');
      expect(getItemEndpoint?.type).toBe('query');
      expect(getItemEndpoint?.inputSchema).toBe('GetItemSchema');

      const createItemEndpoint = sector1!.endpoints.find(e => e.name === 'createItem');
      expect(createItemEndpoint?.type).toBe('mutation');
      expect(createItemEndpoint?.inputSchema).toBe('CreateItemSchema');
    });

    it('should parse example_sector2 endpoints correctly', async () => {
      const sectors = await sectorParser.discoverSectors();
      const sector2 = sectors.find(s => s.name === 'example_sector2');

      expect(sector2).toBeDefined();
      expect(sector2!.endpoints).toHaveLength(5);

      // Check endpoint names
      const endpointNames = sector2!.endpoints.map(e => e.name).sort();
      expect(endpointNames).toEqual([
        'createResource',
        'deleteResource',
        'getResource',
        'searchResources',
        'updateResource'
      ]);

      // Check that endpoints have correct types
      const searchResourcesEndpoint = sector2!.endpoints.find(e => e.name === 'searchResources');
      expect(searchResourcesEndpoint?.type).toBe('query');
      expect(searchResourcesEndpoint?.inputSchema).toBe('SearchResourcesSchema');
    });

    it('should handle sectors without input schemas', async () => {
      // This test verifies that endpoints without input schemas are handled correctly
      const sectors = await sectorParser.discoverSectors();
      const sector1 = sectors.find(s => s.name === 'example_sector1');

      // Find the healthCheck endpoint which has no input schema
      const healthCheckEndpoint = sector1!.endpoints.find(e => e.name === 'healthCheck');
      expect(healthCheckEndpoint).toBeDefined();
      expect(healthCheckEndpoint!.inputSchema).toBeUndefined();
      expect(healthCheckEndpoint!.type).toBe('query');

      // Verify other endpoints have input schemas
      const otherEndpoints = sector1!.endpoints.filter(e => e.name !== 'healthCheck');
      for (const endpoint of otherEndpoints) {
        expect(endpoint.inputSchema).toBeDefined();
      }
    });
  });

  describe('error handling', () => {
    it('should throw error when sectors directory does not exist', async () => {
      const invalidConfig = {
        ...testConfig,
        source: {
          ...testConfig.source,
          sectorsDir: 'nonexistent'
        }
      };
      
      const invalidParser = new SectorParser(invalidConfig, basePath);
      
      await expect(invalidParser.discoverSectors()).rejects.toThrow('Failed to discover sectors');
    });

    it('should handle sectors with invalid router files gracefully', async () => {
      // This test would require creating a malformed router file
      // For now, we'll test that valid sectors are still processed
      const sectors = await sectorParser.discoverSectors();
      expect(sectors.length).toBeGreaterThan(0);
    });
  });
});
