import { z } from 'zod';
import { SAMSUNG_CARD_TYPES } from '../../../shared/contracts/wallet-providers.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { DEFAULT_CARD_TYPE, samsungCardId } from './samsung-cards.ts';

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
  cardType: z.enum(SAMSUNG_CARD_TYPES),
  cardSubType: z.literal('others'),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  appLinkLogo: HttpsUrlSchema,
  appLinkName: z.string().min(1).max(32),
  appLinkData: HttpsUrlSchema,
});
const ProjectionV1Schema = z
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

/**
 * Schema 2 (architecture 4.3): the compiler is the content, so a candidate pins what it was
 * approved against instead of mapping fields. `provider` is the architecture's `target`.
 */
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const ProjectionV2Schema = z.strictObject({
  schema: z.literal(2),
  provider: NativeProviderSchema,
  type: z.string().min(1).max(32),
  compilerRevision: z.number().int().positive(),
  /**
   * SHA-256 over everything that builds the report besides the version: the compiler revision, the
   * fidelity revision, the capability matrix and the art rules. Q21 compares this, not one part.
   */
  pipeline: Sha256Schema,
  /** SHA-256 of the canonical `manifest.wallets` block (`null` when the version has none). */
  wallets: Sha256Schema,
  /** SHA-256 of the canonical fidelity report. */
  report: Sha256Schema,
  /** Every omission the reviewer approved, as `capability` or `capability@path`, sorted. */
  approvedOmissions: z.array(z.string().min(1).max(200)).max(200),
});
export type ProjectionV2 = z.infer<typeof ProjectionV2Schema>;
/** What an author sends: the server computes every pin and requires the omissions to match. */
export const ProjectionV2RequestSchema = z.strictObject({
  schema: z.literal(2),
  provider: NativeProviderSchema,
  approvedOmissions: ProjectionV2Schema.shape.approvedOmissions,
});

export type ProjectionV2Request = z.infer<typeof ProjectionV2RequestSchema>;

export const NativeProjectionSchema = z.union([ProjectionV1Schema, ProjectionV2Schema]);
export type NativeProjection = z.infer<typeof NativeProjectionSchema>;
export type ProjectionV1 = Exclude<NativeProjection, ProjectionV2>;
export type GoogleProjection = z.infer<typeof GoogleProjectionSchema>;
export type SamsungProjection = z.infer<typeof SamsungProjectionSchema>;

/** Normalize an unordered schema 1 acknowledgement before it is hashed and shown to a reviewer. */
export function normalizeNativeProjection(input: unknown): ProjectionV1 {
  const value = ProjectionV1Schema.parse(input);
  return { ...value, sourceArtworkSlots: [...value.sourceArtworkSlots].sort() };
}

/** What a candidate request may carry: schema 1, or schema 2 as a request or with its pins. */
export function parseProjectionInput(
  input: unknown,
): ProjectionV1 | ProjectionV2 | ProjectionV2Request {
  const request = ProjectionV2RequestSchema.safeParse(input);
  if (request.success) return request.data;
  const pinned = ProjectionV2Schema.safeParse(input);
  return pinned.success ? pinned.data : normalizeNativeProjection(input);
}

/**
 * Schema 1 maps fields by hand. Google never published it and Samsung's is retired with its evidence, so
 * only a compiled (schema 2) candidate is published; schema 1 remains readable for history.
 */
export function publishableSchema(_provider: NativeProvider, schema: 1 | 2): boolean {
  return schema === 2;
}

/** The non-secret provider identity is hashed; private credentials never enter a projection. */
export type ProviderIdentitySnapshot =
  | { provider: 'google'; credentials: { issuerId: string } }
  | {
      provider: 'samsung';
      credentials: { partnerId: string; cardId: string; cardIds?: Record<string, string> };
    };
/** The Samsung card type whose card identifies a projection: schema 1 names it, schema 2 compiles it. */
export function identityCardType(projection: NativeProjection): string | undefined {
  if (projection.provider !== 'samsung') return undefined;
  return projection.schema === 1 ? projection.cardType : projection.type;
}

/** Samsung: the partner plus the card of the projection's type (`cardType`, default card if omitted). */
export function providerIdentityHash(
  snapshot: ProviderIdentitySnapshot,
  cardType = DEFAULT_CARD_TYPE,
): Promise<string> {
  return sha256Hex(
    canonicalJson(
      snapshot.provider === 'google'
        ? { provider: 'google', issuerId: snapshot.credentials.issuerId }
        : {
            provider: 'samsung',
            partnerId: snapshot.credentials.partnerId,
            cardId: samsungCardId(snapshot.credentials, cardType),
          },
    ),
  );
}
export function projectionPolicy(provider: NativeProvider) {
  return provider === 'google' ? GOOGLE_PROJECTION_POLICY : SAMSUNG_PROJECTION_POLICY;
}
