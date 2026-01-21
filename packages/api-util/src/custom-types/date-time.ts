import z from 'zod';

export class LocalDateValue extends String {
  static date_validation_regex = /^\d{4}-\d{2}-\d{2}$/;
  constructor(value: unknown) {
    if (value instanceof Date) {
      value = value.toISOString().split('T')[0];
    }
    super(value);
    if (!this.match(LocalDateValue.date_validation_regex)) {
      throw new Error('Invalid Date');
    }
  }
}

export const LocalDateSchema:z.ZodType<string> = z.string().regex(LocalDateValue.date_validation_regex);

export const DateTimeRangeSchema:z.ZodType<{ start: Date; end: Date }> = z.object({
  start: z.date(),
  end: z.date(),
});
export type DateTimeRange = z.infer<typeof DateTimeRangeSchema>;

export const LocalDateRangeSchema:z.ZodType<{ start: string; end: string }> = z.object({
  start: LocalDateSchema,
  end: LocalDateSchema,
});