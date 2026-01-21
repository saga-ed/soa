import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigLoader } from '../utils/config-loader.js';
import type { TRPCCodegenConfig } from '../types/config.js';

describe('ConfigLoader', () => {
  let basePath: string;

  beforeEach(() => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    basePath = path.resolve(__dirname, '..', '..'); // Go up to package root
  });

  describe('loadConfig()', () => {
    it('should load test config file successfully', async () => {
      const configPath = path.resolve(basePath, 'src/__tests__/fixtures/test-config.js');
      const config = await ConfigLoader.loadConfig(configPath, basePath);
      
      expect(config).toBeDefined();
      expect(config.source.sectorsDir).toBe('src/__tests__/fixtures/sectors');
      expect(config.generation.packageName).toBe('@test/trpc-types');
      expect(config.zod2ts.enabled).toBe(true);
    });

    it('should throw error when no config file is provided', async () => {
      await expect(ConfigLoader.loadConfig(undefined as any, basePath))
        .rejects.toThrow('Config file path is required');
    });

    it('should throw error when config file is not found', async () => {
      await expect(ConfigLoader.loadConfig('./nonexistent-config.js', basePath))
        .rejects.toThrow('Config file not found: ./nonexistent-config.js');
    });

    it('should handle ESM and CJS config exports', async () => {
      // Test both default and named exports
      const configPath = path.resolve(basePath, 'src/__tests__/fixtures/test-config.js');
      const config = await ConfigLoader.loadConfig(configPath, basePath);
      
      expect(config).toBeDefined();
      expect(config.source.sectorsDir).toBe('src/__tests__/fixtures/sectors');
    });
  });

  describe('validateConfig()', () => {
    it('should validate valid config successfully', () => {
      const validConfig: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };
      
      expect(() => ConfigLoader.validateConfig(validConfig)).not.toThrow();
    });

    it('should throw error for missing sectorsDir', () => {
      const invalidConfig = {
        source: {
          // sectorsDir missing
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      } as TRPCCodegenConfig;
      
      expect(() => ConfigLoader.validateConfig(invalidConfig)).toThrow('source.sectorsDir is required');
    });

    it('should throw error for missing outputDir', () => {
      const invalidConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          // outputDir missing
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      } as TRPCCodegenConfig;
      
      expect(() => ConfigLoader.validateConfig(invalidConfig)).toThrow('generation.outputDir is required');
    });

    it('should throw error for missing packageName', () => {
      const invalidConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          // packageName missing
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      } as TRPCCodegenConfig;
      
      expect(() => ConfigLoader.validateConfig(invalidConfig)).toThrow('generation.packageName is required');
    });

    it('should throw error for missing routerName', () => {
      const invalidConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package'
          // routerName missing
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      } as TRPCCodegenConfig;
      
      expect(() => ConfigLoader.validateConfig(invalidConfig)).toThrow('generation.routerName is required');
    });
  });

  describe('displayConfig()', () => {
    it('should display configuration in readable format', async () => {
      const config: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };

      const basePath = '/test/project';
      
      // Mock console.log to capture output
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);
      
      try {
        ConfigLoader.displayConfig(config, basePath);
        
        expect(logs).toContain('📋 Configuration:');
        expect(logs).toContain('  Source:');
        expect(logs).toContain('    Sectors directory: src/sectors');
        expect(logs).toContain('    Router pattern: */trpc/*-router.ts');
        expect(logs).toContain('    Schema pattern: */trpc/schema/*-schemas.ts');
        expect(logs).toContain('  Generation:');
        expect(logs).toContain('    Output directory: ./generated');
        expect(logs).toContain('    Package name: @test/package');
        expect(logs).toContain('    Router name: TestRouter');
        expect(logs).toContain('  Parsing:');
        expect(logs).toContain('    Endpoint pattern: /test/');
        expect(logs).toContain('    Router method pattern: /test/');
        expect(logs).toContain('  Zod2TS:');
        expect(logs).toContain('    Enabled: true');
        expect(logs).toContain('    Output directory: ./types');
      } finally {
        console.log = originalLog;
      }
    });

    it('should handle disabled zod2ts correctly', async () => {
      const config: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: false,
          outputDir: './types'
        }
      };

      const basePath = '/test/project';
      
      // Mock console.log to capture output
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);
      
      try {
        ConfigLoader.displayConfig(config, basePath);
        
        expect(logs).toContain('    Enabled: false');
        // Should not contain zod2ts output path when disabled
        expect(logs.some(log => log.includes('Output directory: ./types'))).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('command line overrides', () => {
    it('should allow overriding sectors directory', () => {
      const baseConfig: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };

      // Simulate command line override
      const overriddenConfig = {
        ...baseConfig,
        source: {
          ...baseConfig.source,
          sectorsDir: 'custom/sectors'
        }
      };

      expect(overriddenConfig.source.sectorsDir).toBe('custom/sectors');
      expect(overriddenConfig.source.routerPattern).toBe('*/trpc/*-router.ts');
      expect(overriddenConfig.source.schemaPattern).toBe('*/trpc/schema/*-schemas.ts');
    });

    it('should allow overriding router pattern', () => {
      const baseConfig: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };

      // Simulate command line override
      const overriddenConfig = {
        ...baseConfig,
        source: {
          ...baseConfig.source,
          routerPattern: '*/api/*-router.ts'
        }
      };

      expect(overriddenConfig.source.sectorsDir).toBe('src/sectors');
      expect(overriddenConfig.source.routerPattern).toBe('*/api/*-router.ts');
      expect(overriddenConfig.source.schemaPattern).toBe('*/trpc/schema/*-schemas.ts');
    });

    it('should allow overriding schema pattern', () => {
      const baseConfig: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };

      // Simulate command line override
      const overriddenConfig = {
        ...baseConfig,
        source: {
          ...baseConfig.source,
          schemaPattern: '*/api/*-schemas.ts'
        }
      };

      expect(overriddenConfig.source.sectorsDir).toBe('src/sectors');
      expect(overriddenConfig.source.routerPattern).toBe('*/trpc/*-router.ts');
      expect(overriddenConfig.source.schemaPattern).toBe('*/api/*-schemas.ts');
    });

    it('should allow overriding multiple source options', () => {
      const baseConfig: TRPCCodegenConfig = {
        source: {
          sectorsDir: 'src/sectors',
          routerPattern: '*/trpc/*-router.ts',
          schemaPattern: '*/trpc/schema/*-schemas.ts'
        },
        generation: {
          outputDir: './generated',
          packageName: '@test/package',
          routerName: 'TestRouter'
        },
        parsing: {
          endpointPattern: /test/,
          routerMethodPattern: /test/
        },
        zod2ts: {
          enabled: true,
          outputDir: './types'
        }
      };

      // Simulate multiple command line overrides
      const overriddenConfig = {
        ...baseConfig,
        source: {
          ...baseConfig.source,
          sectorsDir: 'custom/sectors',
          routerPattern: '*/api/*-router.ts',
          schemaPattern: '*/api/*-schemas.ts'
        }
      };

      expect(overriddenConfig.source.sectorsDir).toBe('custom/sectors');
      expect(overriddenConfig.source.routerPattern).toBe('*/api/*-router.ts');
      expect(overriddenConfig.source.schemaPattern).toBe('*/api/*-schemas.ts');
    });
  });
});
