import { z } from 'zod';
import { IdSchema, OrgIdSchema, TimestampSchema } from './common.ts';

/** `POST /developer/sandbox`: the Turnstile token of the widget with action `developer_sandbox`. */
export const CreateDeveloperSandboxSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
});
export type CreateDeveloperSandbox = z.infer<typeof CreateDeveloperSandboxSchema>;

/** The sandbox of the signed-in person. Every pass in it is a preview: none is signed, added to a wallet or pushed. */
export const DeveloperSandboxSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  orgSlug: z.string(),
  /** The ticket template made for the quickstart, released in Test. */
  templateId: IdSchema.nullable(),
  previewOnly: z.literal(true),
  createdAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
});
export type DeveloperSandbox = z.infer<typeof DeveloperSandboxSchema>;

/**
 * The create response: the sandbox and its test key, whose secret is shown once. A retry that finds the key already
 * made has no secret to show: `key` is null and `previousKey` names it, so the page offers "Roll key".
 */
export const CreatedDeveloperSandboxSchema = DeveloperSandboxSchema.extend({
  key: z
    .object({
      id: IdSchema,
      name: z.string(),
      secret: z.string(),
      mode: z.literal('test'),
      expiresAt: TimestampSchema,
    })
    .nullable(),
  previousKey: z.object({ id: IdSchema, name: z.string() }).nullable(),
});
export type CreatedDeveloperSandbox = z.infer<typeof CreatedDeveloperSandboxSchema>;
