/**
 * Zod helpers for coercing string environment variables into native types.
 *
 * Every SOA-backed service that builds a Zod config schema re-implements the
 * same handful of preprocessors — string→boolean, the empty-string→undefined
 * dance for CFN defaults, comma-separated lists. They were byte-identical
 * copies across iam-api, sis-api, and every student-data-system / coach /
 * program-hub service. Hoisted here so the config schema layer has one source
 * of truth.
 *
 * Pairs with {@link DotenvConfigManager}: the loader assigns a DEFINED env var
 * verbatim (including `''`), so a schema that wants a field to be genuinely
 * optional on an empty default must wrap it in {@link emptyStringToUndefined}.
 *
 * zod 3.x — matches the version every downstream service pins (3.25.67).
 */
import { z } from 'zod';

/**
 * Coerce a string env var to a boolean. `'true'` (exactly) → `true`; any other
 * string → `false`; a non-string value (a real boolean default) passes through
 * to `z.boolean()`. Compose with `.default(...)` / `.optional()` as needed:
 *
 * ```ts
 * const Schema = z.object({ ssl: envBoolean.default(false) });
 * ```
 */
export const envBoolean = z.preprocess(
  (val) => (typeof val === 'string' ? val === 'true' : val),
  z.boolean(),
);

/**
 * Wrap an inner schema so a defined-but-empty env var (`''`) becomes
 * `undefined` before validation.
 *
 * LOAD-BEARING: the soa-config loader assigns a DEFINED env var verbatim,
 * including `''` (a common CloudFormation default), so a bare
 * `.optional()` / `.url()` would see `''` — letting it through, or (for
 * `.url()`) rejecting it and failing boot in every environment. Wrapping keeps
 * the field genuinely optional on the empty default.
 *
 * The INNER schema must itself tolerate `undefined` — put `.optional()` (or
 * `.default(...)`) on the schema you pass in, NOT on the result, so the
 * empty-string→undefined value is accepted:
 *
 * ```ts
 * const Schema = z.object({
 *   loginHost: emptyStringToUndefined(z.string().url().optional()),
 * });
 * ```
 */
export const emptyStringToUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner);

/**
 * Coerce a string env var to a finite number. Thin alias over `z.coerce.number()`
 * provided so config schemas read consistently alongside {@link envBoolean}.
 * Compose with `.int()`, `.positive()`, `.default(...)`:
 *
 * ```ts
 * const Schema = z.object({ port: envNumber.int().positive() });
 * ```
 */
export const envNumber = z.coerce.number();

/**
 * Parse a comma-separated env var into a trimmed, non-empty `string[]`.
 * Mirrors the `CORS_ORIGIN` parsing in `@saga-ed/soa-api-util`. An undefined or
 * empty var yields `[]`. Compose with `.default([])` for explicitness:
 *
 * ```ts
 * const Schema = z.object({ allowedOrigins: envStringArray });
 * ```
 */
export const envStringArray = z.preprocess(
  (val) =>
    typeof val === 'string'
      ? val
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : val,
  z.array(z.string()).default([]),
);
