import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import { EntitlementValueSchema } from './entitlement-admin.ts';
import { ENTITLEMENT_KEYS, type EntitlementKey, parseEntitlementValue } from './entitlements.ts';

export const EntitlementPresetSchema = z.object({
  preset: z.string(),
  label: z.string(),
  /** Compare-and-set token of an edit. */
  revision: z.number().int().min(1),
  updatedAt: TimestampSchema,
  /** Organizations on it now. */
  orgCount: z.number().int().min(0),
  /** Organizations an earlier edit has not reached yet; apply the edit again to continue. */
  pendingOrgs: z.number().int().min(0),
  values: z.record(z.string(), EntitlementValueSchema),
});

export const EntitlementPresetsSchema = z.object({ presets: z.array(EntitlementPresetSchema) });

/**
 * The values to change on one preset; a key not listed keeps its value. An empty `values` changes nothing and
 * carries on moving the organizations a previous edit has not reached. `expectedRevision` is the revision read;
 * a stale one is refused (409).
 */
export const SetEntitlementPresetSchema = z
  .strictObject({
    preset: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/),
    expectedRevision: z.number().int().min(1),
    values: z.partialRecord(z.string(), EntitlementValueSchema),
  })
  .superRefine((body, ctx) => {
    for (const [key, value] of Object.entries(body.values)) {
      const known = ENTITLEMENT_KEYS.find((k) => k === key);
      if (known === undefined) {
        ctx.addIssue({ code: 'custom', path: ['values', key], message: 'Unknown feature.' });
      } else if (parseEntitlementValue(known as EntitlementKey, value) === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['values', key],
          message: 'Not a valid value for this feature.',
        });
      }
    }
  });

export const SetEntitlementPresetResultSchema = z.object({
  preset: EntitlementPresetSchema,
  /** Organizations moved by this call. */
  moved: z.number().int().min(0),
});

export type EntitlementPresetDto = z.infer<typeof EntitlementPresetSchema>;
export type SetEntitlementPresetInput = z.input<typeof SetEntitlementPresetSchema>;
export type SetEntitlementPresetResult = z.infer<typeof SetEntitlementPresetResultSchema>;
