import { z } from 'zod';
import { EMAIL_INVALID_MESSAGE, strictEmail } from '../email.ts';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';

/** Join links: a public link and QR that makes a pass with no operator. */

export const JOIN_NAME_MAX = 40;
export const JOIN_LIMIT_MAX = 5000;
/** Test-mode links hold at most this many cards a day (the table CHECK says the same). */
export const JOIN_TEST_LIMIT_MAX = 50;
export const JOIN_LIMIT_DEFAULT = 200;
export const JOIN_FORM_MAX_BYTES = 4096;
export const JOIN_NAME_MESSAGE = 'Enter your first name.';

const REFUSED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u;
/** Tested on the NFKC form, so full-width `ｗｗｗ．` and `＠` count. */
const LINKISH = /:\/\/|www\.|@/i;

/** One first name: NFC, trimmed, spaces collapsed; no controls, bidi or zero-width marks, no URL or address. */
export const JoinNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, JOIN_NAME_MESSAGE)
      .max(JOIN_NAME_MAX, JOIN_NAME_MESSAGE)
      .refine(
        (value) => !REFUSED.test(value) && !LINKISH.test(value.normalize('NFKC')),
        JOIN_NAME_MESSAGE,
      ),
  );

export const JoinReadinessCodeSchema = z.enum([
  'no_release',
  'barcode_input',
  'input_needed',
  'archived',
]);
export const JoinReadinessIssueSchema = z.object({
  code: JoinReadinessCodeSchema,
  input: z.string().optional(),
});
export type JoinReadinessIssue = z.infer<typeof JoinReadinessIssueSchema>;

const InputRefSchema = z.object({ key: z.string(), label: z.string() });

export const JoinLinkSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  mode: ModeSchema,
  enabled: z.boolean(),
  nameInput: z.string().nullable(),
  nameInputs: z.array(InputRefSchema),
  askEmail: z.boolean(),
  generated: z.array(InputRefSchema),
  dailyLimit: z.number().int(),
  issuedToday: z.number().int(),
  limitReached: z.boolean(),
  /** Null without `passes:operate`. */
  url: z.string().url().nullable(),
  ready: z.boolean(),
  issues: z.array(JoinReadinessIssueSchema),
  revision: z.number().int(),
  createdAt: TimestampSchema,
  rotatedAt: TimestampSchema.nullable(),
});
export type JoinLinkDto = z.infer<typeof JoinLinkSchema>;

export const JoinLinkStateSchema = z.object({
  link: JoinLinkSchema.nullable(),
  ready: z.boolean(),
  issues: z.array(JoinReadinessIssueSchema),
});
export type JoinLinkState = z.infer<typeof JoinLinkStateSchema>;

export const JoinLinkParamsSchema = z.object({ templateId: IdSchema });

/** `revision` 0 creates the link. */
export const JoinLinkUpdateSchema = z.strictObject({
  enabled: z.boolean().optional(),
  nameInput: z.string().max(64).nullable().optional(),
  askEmail: z.boolean().optional(),
  dailyLimit: z.number().int().min(1).max(JOIN_LIMIT_MAX).optional(),
  revision: z.number().int().min(0),
});
export type JoinLinkUpdate = z.infer<typeof JoinLinkUpdateSchema>;

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** The public form. An empty email box is no email. */
export const JoinSubmitSchema = z.strictObject({
  name: JoinNameSchema.optional(),
  email: z
    .preprocess(
      blankToUndefined,
      z
        .string()
        .max(254)
        .transform((value, ctx) => {
          const email = strictEmail(value);
          if (email === null) {
            ctx.addIssue({ code: 'custom', message: EMAIL_INVALID_MESSAGE });
            return z.NEVER;
          }
          return email;
        })
        .optional(),
    )
    .optional(),
  'cf-turnstile-response': z.string().min(1).max(2048),
});
export type JoinSubmit = z.infer<typeof JoinSubmitSchema>;

/** Stable log and refusal codes. `JOIN_NOT_READY` and `JOIN_PLATFORM_CAP` log at error. */
export const JOIN_CODES = [
  'JOIN_LINK_CLOSED',
  'JOIN_LIMIT',
  'JOIN_DEVICE_LIMIT',
  'JOIN_IP_LIMIT',
  'JOIN_TURNSTILE_FAILED',
  'JOIN_DUPLICATE',
  'JOIN_EMAIL_CAPPED',
  'JOIN_REPLAY',
  'JOIN_NOT_READY',
  'JOIN_PLATFORM_CAP',
  'JOIN_LINK_CHANGED',
] as const;
export type JoinCode = (typeof JOIN_CODES)[number];
