import { z } from 'zod';
import { EmailSchema, IdSchema } from './common.ts';
import { TagReadSchema } from './nfc-tags.ts';
import { UuidV7Schema } from './scan-base.ts';

/** Offboard a person: name them by email or by the connection's external id. */
export const OffboardRequestSchema = z
  .strictObject({
    holderEmail: EmailSchema.optional(),
    externalId: z.string().min(1).max(200).optional(),
    passes: z.enum(['void', 'remove']).default('void'),
    /** Tags handed back become spares; tags not handed back are reported lost. */
    tags: z.enum(['spare', 'lost']).default('spare'),
    dryRun: z.boolean().default(false),
  })
  .refine((r) => (r.holderEmail === undefined) !== (r.externalId === undefined), {
    message: 'Name the person by email or external ID.',
  });
export type OffboardRequest = z.infer<typeof OffboardRequestSchema>;
export const OffboardResultSchema = z.object({
  dryRun: z.boolean(),
  /** Holders matched by the email or the external ID. */
  holders: z.number().int(),
  /** Passes handled by this call: at most 100. */
  passes: z.number().int(),
  tags: z.number().int(),
  /** More passes of this person remain: send the same request again. */
  more: z.boolean(),
});

/** A tag the desk collects at sign-out: handed back, kept by the visitor (reported lost), or none to collect. */
export const SignOutTagSchema = z.enum(['returned', 'not_returned', 'none']);
/** A visitor leaves: out of every place, and a lent tag collected. Name the pass, or tap the lent tag instead. */
export const SignOutRequestSchema = z
  .strictObject({
    idempotencyKey: UuidV7Schema,
    passId: IdSchema.optional().describe('The pass to sign out. Send this or `read`, not both.'),
    read: TagReadSchema.optional().describe(
      'The lent tag, tapped instead of naming the pass. Its binding names the pass; a tag that is not lent is 409 TAG_NOT_LENT.',
    ),
    tag: SignOutTagSchema.optional().describe(
      "What happened to the pass's lent tag. Default `none` with `passId` (the tag stays lent), `returned` with `read`.",
    ),
  })
  .refine((r) => (r.passId === undefined) !== (r.read === undefined), {
    message: 'Name the pass or tap its tag.',
  })
  .refine((r) => r.read === undefined || r.tag === undefined || r.tag === 'returned', {
    message: 'A tag tap hands the tag back.',
    path: ['tag'],
  });
export const SignOutResultSchema = z.object({
  passId: IdSchema,
  stayMs: z.number().int().nonnegative().nullable(),
  /** Places the person is still inside that this device cannot mark out. */
  stillInside: z
    .number()
    .int()
    .nonnegative()
    .describe('Places the person is still inside that this device could not mark out.'),
  tag: SignOutTagSchema.describe(
    'What happened to the lent tag; `none` when the pass had none to collect.',
  ),
});
