import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

export const AgreementKindSchema = z.enum(['agreement', 'waiver']);
/** How a minor signs: not at all, or a guardian signs for them (one minor per walk-in, K-D12). */
export const AgreementMinorsSchema = z.enum(['none', 'guardian']);
/** One text per version, English, plain text (K-D19). */
export const AGREEMENT_BODY_MAX = 20_000;
export const AGREEMENT_SIGNATURE_MAX_BYTES = 65_536;
const BodySchema = z.string().trim().min(1).max(AGREEMENT_BODY_MAX);

export const AgreementVersionSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1),
  title: PlainLineSchema(80),
  body: BodySchema,
  /** Null: a draft. A published version never changes; an edit makes a new one. */
  publishedAt: TimestampSchema.nullable(),
  /** Only drives the "current acceptance" status in admin; a walk-in always signs the current version. */
  requiresReaccept: z.boolean(),
});
export type AgreementVersion = z.infer<typeof AgreementVersionSchema>;
export const AgreementSchema = z.strictObject({
  id: IdSchema,
  mode: ModeSchema,
  kind: AgreementKindSchema,
  title: PlainLineSchema(80),
  minors: AgreementMinorsSchema,
  archivedAt: TimestampSchema.nullable(),
  current: AgreementVersionSchema.nullable(),
});
export type Agreement = z.infer<typeof AgreementSchema>;
export const AgreementCreateSchema = z.strictObject({
  kind: AgreementKindSchema,
  title: PlainLineSchema(80),
  minors: AgreementMinorsSchema.default('none'),
});
export const AgreementPatchSchema = z.strictObject({
  title: PlainLineSchema(80).optional(),
  minors: AgreementMinorsSchema.optional(),
  archived: z.boolean().optional(),
});
export const AgreementVersionCreateSchema = z.strictObject({
  title: PlainLineSchema(80),
  body: BodySchema,
  requiresReaccept: z.boolean().default(false),
});
export const AgreementListQuerySchema = PageQuerySchema.extend({
  kind: AgreementKindSchema.optional(),
});
export const AgreementListSchema = pageOf(AgreementSchema);

/** What the kiosk is sent per agreement in `/scan/kiosk/config`: the current published words and nothing else. */
export const KioskAgreementTextSchema = z.strictObject({
  agreementId: IdSchema,
  versionId: IdSchema,
  kind: AgreementKindSchema,
  title: PlainLineSchema(80),
  body: BodySchema,
  minors: AgreementMinorsSchema,
});
export type KioskAgreementText = z.infer<typeof KioskAgreementTextSchema>;

export const SignerRoleSchema = z.enum(['self', 'guardian']);
/** A signature PNG as base64, at most 64 KB decoded. */
export const SignaturePngSchema = z
  .string()
  .max(Math.ceil((AGREEMENT_SIGNATURE_MAX_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Sign again.');
/** One acceptance in a walk-in: the version signed, who signed, and the signature. */
export const AgreementAcceptanceInputSchema = z
  .strictObject({
    versionId: IdSchema,
    signerRole: SignerRoleSchema,
    typedName: PlainLineSchema(80),
    /** The minor's name, only with `signerRole: 'guardian'`. */
    minorName: PlainLineSchema(80).optional(),
    signature: SignaturePngSchema.optional(),
  })
  .refine(
    (a) => (a.signerRole === 'guardian') === (a.minorName !== undefined),
    'Name the minor, and only for a guardian.',
  );
export type AgreementAcceptanceInput = z.infer<typeof AgreementAcceptanceInputSchema>;

/** `GET /passes/{id}/agreements`: the signature itself is only at `…/signature`, for `scanning:admin`. */
export const AgreementAcceptanceSchema = z.strictObject({
  id: IdSchema,
  agreementId: IdSchema,
  versionId: IdSchema,
  version: z.number().int().min(1),
  kind: AgreementKindSchema,
  title: PlainLineSchema(80),
  acceptedAt: TimestampSchema,
  signerRole: SignerRoleSchema,
  typedName: PlainLineSchema(80),
  minorName: PlainLineSchema(80).nullable(),
  hasSignature: z.boolean(),
  /** The version is still the current one. */
  current: z.boolean(),
});
export type AgreementAcceptance = z.infer<typeof AgreementAcceptanceSchema>;
export const AgreementAcceptanceListSchema = z.strictObject({
  items: z.array(AgreementAcceptanceSchema).max(100),
});
