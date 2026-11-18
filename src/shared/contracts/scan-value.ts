import { z } from 'zod';
import { JsonSchema } from './common.ts';

/** The value a scan read or changed. */
export const ScanValueSchema = z.object({
  input: z.string(),
  label: z.string(),
  before: JsonSchema.nullable(),
  after: JsonSchema.nullable(),
  goal: z.number().nullable(),
  format: z.enum(['number', 'currency', 'text']),
  currency: z.string().optional(),
  /** The input is a counter: a refusal uses the counter's wording. */
  counter: z.boolean().optional(),
  /** A refused `take`: what it asked for. */
  need: z.number().nullable().optional(),
});
