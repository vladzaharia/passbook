import { z } from 'zod';

/** What a `set` may be set to: the input's own schema, so the desk can offer typed entry. The server still validates. */
export const ScanActionInputSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  label: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  maxLength: z.number().int().optional(),
  enum: z
    .array(z.union([z.string(), z.number()]))
    .max(50)
    .optional(),
});
export type ScanActionInput = z.infer<typeof ScanActionInputSchema>;
