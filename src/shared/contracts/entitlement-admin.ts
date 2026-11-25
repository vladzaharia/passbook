import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  EntitlementKeySchema,
  parseEntitlementValue,
} from './entitlements.ts';

/** A stored value as the API shows it: a flag or limit, a level, a list, or `null` (no limit). */
export const EntitlementValueSchema = z.union([
  z.number(),
  z.string().max(64),
  z.array(z.string().max(130)).max(64),
  z.null(),
]);

export const OrgEntitlementsParamsSchema = z.strictObject({ id: IdSchema });

/** Where a resolved value comes from: the preset, or a platform override (with its note and expiry). */
export const EntitlementItemSchema = z.object({
  key: EntitlementKeySchema,
  value: EntitlementValueSchema,
  /** What the preset alone would give; equal to `value` unless an override stands. */
  presetValue: EntitlementValueSchema,
  source: z.enum(['preset', 'override']),
  note: z.string().nullable(),
  expiresAt: TimestampSchema.nullable(),
});

export const PresetOptionSchema = z.object({
  preset: z.string(),
  label: z.string(),
  /** Organizations on it now. */
  orgCount: z.number().int().min(0),
  values: z.record(z.string(), EntitlementValueSchema),
});

export const OrgEntitlementsSchema = z.object({
  orgId: IdSchema,
  /** Null when the organization has no features row: nothing is on until a preset is applied. */
  preset: z.string().nullable(),
  presetLabel: z.string().nullable(),
  /** The compare-and-set token of a write; 0 is "no row yet" and the first write creates it. */
  revision: z.number().int().min(0),
  updatedAt: TimestampSchema.nullable(),
  items: z.array(EntitlementItemSchema),
  presets: z.array(PresetOptionSchema),
});

/** What an organization's own admins see: no notes, no revision, no other presets. */
export const OrgOwnEntitlementsSchema = z.object({
  orgId: IdSchema,
  preset: z.string().nullable(),
  label: z.string().nullable(),
  items: z.array(
    z.object({
      key: EntitlementKeySchema,
      value: EntitlementValueSchema,
      source: z.enum(['preset', 'override']),
    }),
  ),
  /** What the organization holds against each limit now: live and test passes, templates, scanners, members, API keys, webhook endpoints, connections. */
  usage: z.record(z.string(), z.number().int().min(0)),
});

export const EntitlementOverrideSchema = z.strictObject({
  value: EntitlementValueSchema,
  note: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((n) => (n ? n : null)),
  expiresAt: TimestampSchema.nullish().transform((t) => t ?? null),
});

/**
 * The whole state after the change: the preset and every override that should stand. An override not listed
 * is removed. `expectedRevision` is the revision the caller read (0 when the organization has no row yet); a stale one is refused (409).
 */
export const SetOrgEntitlementsSchema = z
  .strictObject({
    expectedRevision: z.number().int().min(0),
    preset: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/),
    overrides: z.partialRecord(z.string(), EntitlementOverrideSchema),
  })
  .superRefine((body, ctx) => {
    for (const [key, override] of Object.entries(body.overrides)) {
      const known = ENTITLEMENT_KEYS.find((k) => k === key);
      if (known === undefined) {
        ctx.addIssue({ code: 'custom', path: ['overrides', key], message: 'Unknown feature.' });
      } else if (parseEntitlementValue(known as EntitlementKey, override?.value) === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides', key, 'value'],
          message: 'Not a valid value for this feature.',
        });
      }
    }
  });

export type EntitlementValueDto = z.infer<typeof EntitlementValueSchema>;
export type EntitlementItemDto = z.infer<typeof EntitlementItemSchema>;
export type PresetOptionDto = z.infer<typeof PresetOptionSchema>;
export type OrgEntitlementsDto = z.infer<typeof OrgEntitlementsSchema>;
export type SetOrgEntitlementsInput = z.input<typeof SetOrgEntitlementsSchema>;
