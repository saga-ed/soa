/* eslint-disable @typescript-eslint/naming-convention */
import { LocalDateValue, DateTimeRange } from '@saga-ed/soa-api-util';
import { Factory } from 'fishery';

export interface DateTimeRangeFactoryTransientParams {
  start_date?: Date;
  duration_ms?: number;
}

export const LocalDateValueFactory = Factory.define<LocalDateValue>(({ sequence }) => {
  return new LocalDateValue(new Date(new Date('2025-01-01T00:00:00.000Z').getTime() + (sequence - 1) * 24 * 60 * 60 * 1000));
});

/**
 * Factory for DateTimeRange objects.
 */
export const DateTimeRangeFactory = Factory.define<DateTimeRange, DateTimeRangeFactoryTransientParams>(
  ({ sequence, transientParams }) => {
    const start_date = transientParams.start_date ?? new Date('2025-01-01T00:00:00.000Z');
    const duration_ms = transientParams.duration_ms ?? 2 * 60 * 60 * 1000;

    const start = new Date(start_date.getTime() + (sequence - 1) * duration_ms);
    const end = new Date(start.getTime() + duration_ms);

    return { start, end };
  },
);

/**
 * Randomly selects one value from an enum.
 * @param enumObj - The enum object to select from
 * @returns A random enum value
 */
export function oneOf<T extends Record<string, string | number>>(enumObj: T): T[keyof T] {
  const values = Object.values(enumObj) as T[keyof T][];
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex] as T[keyof T];
}

/**
 * Randomly selects one value from an array.
 * @param array - The array to select from
 * @returns A random array element
 */
export function oneOfArray<T>(array: readonly T[]): T {
  if (array.length === 0) {
    throw new Error('Cannot select from empty array');
  }
  const randomIndex = Math.floor(Math.random() * array.length);
  return array[randomIndex] as T;
}