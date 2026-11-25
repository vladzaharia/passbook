import { z } from 'zod';
import { EmailSchema, IdSchema } from './common.ts';
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

/** A visitor leaves: the desk checks them out and collects a lent tag. */
export const SignOutRequestSchema = z.strictObject({
  idempotencyKey: UuidV7Schema,
  passId: IdSchema,
  tag: z.enum(['returned', 'not_returned', 'none']).default('none'),
});
export const SignOutResultSchema = z.object({
  passId: IdSchema,
  stayMs: z.number().int().nonnegative().nullable(),
  tag: z.enum(['returned', 'not_returned', 'none']),
});
