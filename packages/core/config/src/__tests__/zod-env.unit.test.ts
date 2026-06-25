import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  envBoolean,
  emptyStringToUndefined,
  envNumber,
  envStringArray,
} from '../zod-env.js';

describe('envBoolean', () => {
  it("coerces the string 'true' to true", () => {
    expect(envBoolean.parse('true')).toBe(true);
  });

  it('coerces any other string to false', () => {
    expect(envBoolean.parse('false')).toBe(false);
    expect(envBoolean.parse('1')).toBe(false);
    expect(envBoolean.parse('')).toBe(false);
    expect(envBoolean.parse('TRUE')).toBe(false); // exact match only
  });

  it('passes a real boolean through unchanged', () => {
    expect(envBoolean.parse(true)).toBe(true);
    expect(envBoolean.parse(false)).toBe(false);
  });

  it('honors .default() when the value is undefined', () => {
    const schema = envBoolean.default(false);
    expect(schema.parse(undefined)).toBe(false);
    expect(schema.parse('true')).toBe(true);
  });
});

describe('emptyStringToUndefined', () => {
  // The inner schema must tolerate undefined — `.optional()` goes on the schema
  // passed in, not on the result.
  const schema = emptyStringToUndefined(z.string().url().optional());

  it('turns an empty string into undefined for the inner schema', () => {
    expect(schema.parse('')).toBeUndefined();
  });

  it('lets a valid inner value through', () => {
    expect(schema.parse('https://login.wootdev.com')).toBe(
      'https://login.wootdev.com',
    );
  });

  it('still rejects a non-empty invalid value', () => {
    expect(() => schema.parse('not-a-url')).toThrow();
  });
});

describe('envNumber', () => {
  it('coerces numeric strings', () => {
    expect(envNumber.parse('3010')).toBe(3010);
  });

  it('composes with int/positive constraints', () => {
    const port = envNumber.int().positive();
    expect(port.parse('8080')).toBe(8080);
    expect(() => port.parse('-1')).toThrow();
  });
});

describe('envStringArray', () => {
  it('splits, trims, and drops empties', () => {
    expect(envStringArray.parse('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('defaults undefined to an empty array', () => {
    expect(envStringArray.parse(undefined)).toEqual([]);
  });

  it('passes an existing array through', () => {
    expect(envStringArray.parse(['x', 'y'])).toEqual(['x', 'y']);
  });
});
