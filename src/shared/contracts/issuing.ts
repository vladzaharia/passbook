import { z } from 'zod';
import { KINDS } from '../mapping/transform.ts';
import { JsonSchema } from './common.ts';
import { MappingEntrySchema } from './connections.ts';

// Shapes the issuing flows share: import, change runs, connections and the pass page.

const count = z.number().int().nonnegative();

/** One changed field, as the admin reads it: no raw keys, no ISO dates. Null is empty. */
export const FieldChangeSchema = z.object({
  key: z.string().max(64),
  label: z.string().max(200),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type FieldChange = z.infer<typeof FieldChangeSchema>;

/** A plan entry that may also `join` columns. */
export const PlanMappingEntrySchema = MappingEntrySchema.extend({
  transform: z
    .object({ kind: z.enum(KINDS), options: z.record(z.string(), JsonSchema).optional() })
    .optional(),
});
export const PlanMappingSchema = z.record(z.string(), PlanMappingEntrySchema);

export const MAPPING_VALUES_MAX = 20;
export const MappingConfidenceSchema = z.enum(['exact', 'similar', 'values', 'join']);
export const MappingDateFormatSchema = z.enum(['iso', 'ymd', 'mdy', 'dmy']);
export type MappingDateFormat = z.infer<typeof MappingDateFormatSchema>;

export const MappingFieldSuggestionSchema = z.object({
  /** `input` targets a template input; the other two are the pass's own keys. */
  role: z.enum(['holderEmail', 'externalId', 'input']),
  /** The input key, or the role for the pass's own keys. */
  target: z.string().max(64),
  label: z.string().max(200),
  required: z.boolean(),
  /** Column pointers: two or more for a join. Empty when nothing matched. */
  from: z.array(z.string().max(500)).max(4),
  confidence: MappingConfidenceSchema.nullable(),
  /** Existing passes are matched on this field's column. */
  matchBy: z.boolean(),
  /** Ready for the plan; null when nothing matched or a choice is needed (a D/M/Y clash). */
  entry: PlanMappingEntrySchema.nullable(),
  /** Enum targets: the most common values with their option key, null when it needs a choice. */
  values: z
    .array(z.object({ value: z.string().max(80), count, to: z.string().nullable() }))
    .max(MAPPING_VALUES_MAX),
  /** Date targets: the format read, or null with `choices` when two formats fit equally. */
  date: z
    .object({
      format: MappingDateFormatSchema.nullable(),
      choices: z.array(MappingDateFormatSchema).max(4),
      parsed: count,
      total: count,
    })
    .nullable(),
});
export type MappingFieldSuggestion = z.infer<typeof MappingFieldSuggestionSchema>;

export const MappingSuggestionSchema = z.object({
  fields: z.array(MappingFieldSuggestionSchema).max(200),
  unused: z.array(z.object({ pointer: z.string().max(500), label: z.string().max(200) })),
  columns: count,
  used: count,
  /** Required inputs with no column and no default. */
  missing: z.array(z.string().max(64)),
});
export type MappingSuggestion = z.infer<typeof MappingSuggestionSchema>;
