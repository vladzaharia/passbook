import { z } from 'zod';

/** Every queue message. Add a kind here, to JOB_HANDLERS in registry.ts, and implement it in the owning module. */
export const JobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('push.deliver'), outboxId: z.string() }),
  z.object({ kind: z.literal('email.send'), outboxId: z.string() }),
  z.object({
    kind: z.literal('pass.refresh'),
    passId: z.string(),
    trigger: z.enum(['admin', 'user']),
    actorId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('connection.sync'),
    connectionId: z.string(),
    generation: z.number().int(),
    trigger: z.enum(['schedule', 'webhook', 'admin']),
  }),
  z.object({
    kind: z.literal('connection.webhook'),
    connectionId: z.string(),
    eventId: z.string(),
    refs: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('pass.reissue'),
    passId: z.string(),
    templateVersion: z.string(),
    cause: z.enum(['template_upgrade', 'resign']),
  }),
  z.object({ kind: z.literal('pass.purge-versions'), passId: z.string() }),
  z.object({ kind: z.literal('identity.check'), identityId: z.string() }),
]);

export type Job = z.infer<typeof JobSchema>;
export type JobKind = Job['kind'];
export type JobOf<K extends JobKind> = Extract<Job, { kind: K }>;
