import 'reflect-metadata';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv-flow';
import { Container } from 'inversify';
import { IConfigManager } from '../i-config-manager.js';
import { DotenvConfigManager } from '../dotenv-config-manager.js';
import { ConfigValidationError } from '../config-validation-error.js';
import { MockConfigManager } from '../mocks/mock-config-manager.js';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';

describe('ConfigManager', () => {
  let container: Container;
  const originalEnv = process.env;
  const dotEnvPath = path.join(__dirname, '../../', '.env.test');

  // This is the schema that drives the initialization of the TEST_CONFIG
  const TestSchema = z.object({
    configType: z.literal('TEST_CONFIG'),
    string: z.string().min(3),
    number: z.preprocess(val => Number(val), z.number().int().positive()),
    bool: z.preprocess(val => val === 'true', z.boolean()),
    optional: z.string().optional(),
    enum: z.enum(['option1', 'option2', 'option3']),
  });

  beforeAll(() => {
    // Write a .env.test file for the test
    fs.writeFileSync(
      dotEnvPath,
      [
        'TEST_CONFIG_STRING=hello',
        'TEST_CONFIG_NUMBER=42',
        'TEST_CONFIG_BOOL=true',
        'TEST_CONFIG_OPTIONAL=optional-value',
        'TEST_CONFIG_ENUM=option2',
      ].join('\n')
    );
    dotenv.config({ path: path.dirname(dotEnvPath) });
  });

  beforeEach(() => {
    container = new Container();
  });

  afterAll(() => {
    fs.unlinkSync(path.join(dotEnvPath));
    process.env = originalEnv;
  });

  describe('DotenvConfigManager', () => {
    beforeEach(() => {
      container.bind<IConfigManager>('IConfigManager').to(DotenvConfigManager);
    });

    it('should load and validate config from .env.test using Zod schema', () => {
      const configManager = container.get<IConfigManager>('IConfigManager');
      const config = configManager.get(TestSchema);

      expect(config).toEqual({
        configType: 'TEST_CONFIG',
        string: 'hello',
        number: 42,
        bool: true,
        optional: 'optional-value',
        enum: 'option2',
      });
    });

    it('should throw ConfigValidationError for invalid config', () => {
      const configManager = container.get<IConfigManager>('IConfigManager');

      // Set invalid values
      process.env.TEST_CONFIG_STRING = 'hi'; // too short
      process.env.TEST_CONFIG_NUMBER = '-1'; // not positive
      process.env.TEST_CONFIG_BOOL = 'notabool'; // not 'true'
      process.env.TEST_CONFIG_ENUM = 'invalid'; // not in enum

      expect(() => configManager.get(TestSchema)).toThrow(ConfigValidationError);
    });
  });

  describe('MockConfigManager', () => {
    beforeEach(() => {
      container.bind<IConfigManager>('IConfigManager').to(MockConfigManager);
    });

    it('should generate valid mock data based on schema', () => {
      const configManager = container.get<IConfigManager>('IConfigManager');
      const config = configManager.get(TestSchema);

      // Verify the mock data matches schema requirements
      expect(config.configType).toBe('TEST_CONFIG');
      expect(config.string.length).toBeGreaterThanOrEqual(3);
      expect(typeof config.number).toBe('number');
      expect(config.number).toBeGreaterThan(0);
      expect(typeof config.bool).toBe('boolean');
      expect(config.optional).toBeUndefined();
      expect(TestSchema.shape.enum.options).toContain(config.enum);
    });

    it('should generate data that passes schema validation', () => {
      const configManager = container.get<IConfigManager>('IConfigManager');
      expect(() => configManager.get(TestSchema)).not.toThrow();
    });
  });

  describe('Edge cases for environment variables', () => {
    const dotEnvPath = path.join(__dirname, '../../', '.env.edge');
    const EdgeSchema = z.object({
      configType: z.literal('EDGE_CONFIG'),
      required: z.string(),
      number: z.preprocess(val => Number(val), z.number().int()),
    });

    afterEach(() => {
      if (fs.existsSync(dotEnvPath)) fs.unlinkSync(dotEnvPath);
      delete process.env.EDGE_CONFIG_REQUIRED;
      delete process.env.EDGE_CONFIG_NUMBER;
    });

    it('throws ConfigValidationError when required env vars are missing', () => {
      const configManager = new DotenvConfigManager();
      process.env.EDGE_CONFIG_NUMBER = '123';
      expect(() => configManager.get(EdgeSchema)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError for partial env var set', () => {
      const configManager = new DotenvConfigManager();
      process.env.EDGE_CONFIG_REQUIRED = 'present';
      expect(() => configManager.get(EdgeSchema)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError for malformed .env values', () => {
      fs.writeFileSync(
        dotEnvPath,
        ['EDGE_CONFIG_REQUIRED=present', 'EDGE_CONFIG_NUMBER=notanumber'].join('\n')
      );
      dotenv.config({ path: dotEnvPath });
      const configManager = new DotenvConfigManager();
      expect(() => configManager.get(EdgeSchema)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when .env file is missing', () => {
      const configManager = new DotenvConfigManager();
      expect(() => configManager.get(EdgeSchema)).toThrow(ConfigValidationError);
    });
  });

  describe('Advanced Zod schema (array, nested object, enum)', () => {
    const AdvancedSchema = z.object({
      configType: z.literal('ADVANCED_CONFIG'),
      tags: z.string().array(),
      database: z.object({
        host: z.string(),
        port: z.preprocess(val => Number(val), z.number().int()),
      }),
      env: z.enum(['dev', 'prod', 'test']),
    });

    it('parses valid env values correctly', () => {
      process.env.ADVANCED_CONFIG_TAGS = 'foo,bar,baz';
      process.env.ADVANCED_CONFIG_DATABASE = JSON.stringify({ host: 'localhost', port: 1234 });
      process.env.ADVANCED_CONFIG_ENV = 'prod';
      const configManager = new DotenvConfigManager();
      // Simulate parsing array and object from env
      const schemaWithTransform = AdvancedSchema.extend({
        tags: z.string().transform(s => s.split(',')),
        database: z.string().transform(s => JSON.parse(s)),
      });
      const config = configManager.get(schemaWithTransform as any);
      expect(config.tags).toEqual(['foo', 'bar', 'baz']);
      expect(config.database).toEqual({ host: 'localhost', port: 1234 });
      expect(config.env).toBe('prod');
    });

    it('throws ConfigValidationError for invalid enum or missing nested fields', () => {
      process.env.ADVANCED_CONFIG_TAGS = 'foo,bar';
      process.env.ADVANCED_CONFIG_DATABASE = JSON.stringify({ host: 'localhost' }); // missing port
      process.env.ADVANCED_CONFIG_ENV = 'invalid';
      const configManager = new DotenvConfigManager();
      const schemaWithTransform = AdvancedSchema.extend({
        tags: z.string().transform(s => s.split(',')),
        database: z.string().transform(s => JSON.parse(s)),
      });
      expect(() => configManager.get(schemaWithTransform as any)).toThrow(ConfigValidationError);
    });
  });
});
