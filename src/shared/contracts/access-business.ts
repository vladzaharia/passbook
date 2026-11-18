import { z } from 'zod';
import { EmailSchema, IdSchema, TimestampSchema } from './common.ts';
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
  passes: z.number().int(),
  tags: z.number().int(),
});

export const PassImportStateSchema = z.enum(['checking', 'ready', 'committing', 'done', 'failed']);
export const PassImportRowProblemSchema = z.object({
  row: z.number().int().min(1),
  code: z.string().max(64),
  message: z.string().max(200),
});
export const CreatePassImportSchema = z.strictObject({
  templateId: IdSchema,
  csv: z.string().min(1).max(2_000_000),
});
export const PassImportSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  state: PassImportStateSchema,
  rows: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  problems: z.array(PassImportRowProblemSchema).max(100),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export const PassImportCommitSchema = z.strictObject({
  /** Rows with problems are skipped; false refuses the whole file. */
  skipInvalid: z.boolean().default(true),
  /** Email each new holder their pass now. */
  email: z.boolean().default(false),
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
