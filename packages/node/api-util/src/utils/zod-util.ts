import { z } from "zod";

export type SagaSchema<T = unknown> = z.ZodType<T>;