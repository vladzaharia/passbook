import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

export const VasKeySchema = z.object({
  id: IdSchema,
  identityId: IdSchema,
  orgId: IdSchema,
  keyId: z.string().regex(/^[0-9a-f]{8}$/),
  state: z.enum(['active', 'retiring', 'retired']),
  createdAt: TimestampSchema,
  activatedAt: TimestampSchema,
  retiredAt: TimestampSchema.nullable(),
  passCount: z.number().int(),
  passesLeft: z.number().int().nullable(),
});
export type VasKeyDto = z.infer<typeof VasKeySchema>;
/** The browser makes the P-256 pair; only the public half comes here (base64 SPKI). */
export const CreateVasKeySchema = z.object({
  identityId: IdSchema,
  orgId: IdSchema,
  publicKey: z.string().min(1).max(512),
});
export const NfcStatusSchema = z.object({
  enabled: z.boolean(),
  identities: z.array(
    z.object({
      id: IdSchema,
      label: z.string(),
      nfcEnabled: z.boolean(),
      keys: z.array(VasKeySchema),
    }),
  ),
});
export const NfcTestRequestSchema = z.object({
  identityId: IdSchema,
  orgId: IdSchema,
  message: z.string().min(1).max(64),
});
export const NfcTestResultSchema = z.object({
  pass: z.object({ id: IdSchema, title: z.string(), templateName: z.string() }).nullable(),
});
