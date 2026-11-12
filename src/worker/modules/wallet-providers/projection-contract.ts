import { z } from 'zod';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';

/** These revisions are part of every candidate digest and every atomic eligibility fence. */
export const GOOGLE_PROJECTION_POLICY = {
  adapterRevision: 1,
  adapterCapabilities: ['generic-text', 'qr-code', 'reviewed-artwork'] as const,
  audiencePolicyRevision: 1,
} as const;
export const SAMSUNG_PROJECTION_POLICY = {
  adapterRevision: 1,
  adapterCapabilities: ['loyalty-text', 'qr-code', 'reviewed-artwork'] as const,
  audiencePolicyRevision: 1,
} as const;

export const NativeProviderSchema = z.enum(['google', 'samsung']);
export type NativeProvider = z.infer<typeof NativeProviderSchema>;
const FieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/);
const HttpsUrlSchema = z
  .string()
  .min(1)
  .max(256)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTPS URL without credentials.');
const common = {
  schema: z.literal(1),
  language: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/),
  logoUrl: HttpsUrlSchema,
  sourceArtworkSlots: z
    .array(z.enum(['icon', 'logo']))
    .min(1)
    .max(2),
  titleField: FieldKeySchema,
  fields: z.array(FieldKeySchema).min(1).max(9),
  barcode: z.enum(['none', 'qr']),
};

/** The only approved fields are declared here; provider-specific JSON is never accepted. */
export const GoogleProjectionSchema = z.strictObject({
  ...common,
  provider: z.literal('google'),
});
export const SamsungProjectionSchema = z.strictObject({
  ...common,
  provider: z.literal('samsung'),
  cardType: z.literal('loyalty'),
  cardSubType: z.literal('others'),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  appLinkLogo: HttpsUrlSchema,
  appLinkName: z.string().min(1).max(32),
  appLinkData: HttpsUrlSchema,
});
export const NativeProjectionSchema = z
  .discriminatedUnion('provider', [GoogleProjectionSchema, SamsungProjectionSchema])
  .superRefine((value, context) => {
    if (new Set(value.fields).size !== value.fields.length)
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'Field mappings must be unique.',
      });
    if (!value.fields.includes(value.titleField))
      context.addIssue({
        code: 'custom',
        path: ['titleField'],
        message: 'The title must map a field.',
      });
    if (new Set(value.sourceArtworkSlots).size !== value.sourceArtworkSlots.length)
      context.addIssue({
        code: 'custom',
        path: ['sourceArtworkSlots'],
        message: 'Artwork slots must be unique.',
      });
  });
export type NativeProjection = z.infer<typeof NativeProjectionSchema>;
export type GoogleProjection = z.infer<typeof GoogleProjectionSchema>;
export type SamsungProjection = z.infer<typeof SamsungProjectionSchema>;

/** Normalize an unordered acknowledgement before it is hashed and shown to a reviewer. */
export function normalizeNativeProjection(input: unknown): NativeProjection {
  const value = NativeProjectionSchema.parse(input);
  return { ...value, sourceArtworkSlots: [...value.sourceArtworkSlots].sort() };
}

/** The non-secret provider identity is hashed; private credentials never enter a projection. */
export type ProviderIdentitySnapshot =
  | { provider: 'google'; credentials: { issuerId: string } }
  | { provider: 'samsung'; credentials: { partnerId: string; cardId: string } };
export function providerIdentityHash(snapshot: ProviderIdentitySnapshot): Promise<string> {
  return sha256Hex(
    canonicalJson(
      snapshot.provider === 'google'
        ? { provider: 'google', issuerId: snapshot.credentials.issuerId }
        : {
            provider: 'samsung',
            partnerId: snapshot.credentials.partnerId,
            cardId: snapshot.credentials.cardId,
          },
    ),
  );
}
export function projectionPolicy(provider: NativeProvider) {
  return provider === 'google' ? GOOGLE_PROJECTION_POLICY : SAMSUNG_PROJECTION_POLICY;
}
