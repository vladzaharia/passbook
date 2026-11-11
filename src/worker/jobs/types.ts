import { z } from 'zod';

/** Every queue message. Add a kind here, to JOB_HANDLERS in registry.ts, and implement it in the owning module. */
export const JobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('push.deliver'), outboxId: z.string() }),
  z.object({ kind: z.literal('email.send'), outboxId: z.string() }),
  z.object({
    kind: z.literal('pass.refresh'),
    passId: z.string(),
    orgId: z.string(),
    mode: z.enum(['live', 'test']),
    passVersion: z.number().int().positive(),
    status: z.enum(['active', 'voided']),
    ownerUserId: z.string().nullable(),
    linkGeneration: z.number().int().positive(),
    connectionId: z.string().nullable(),
    externalRef: z.string().nullable(),
    generation: z.number().int().positive().nullable(),
    trigger: z.enum(['admin', 'user']),
    actorId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('connection.webhook'),
    connectionId: z.string(),
    orgId: z.string(),
    generation: z.number().int().positive(),
    eventId: z.string(),
    refs: z.array(z.string()),
  }),
]);

export type Job = z.infer<typeof JobSchema>;
export type JobKind = Job['kind'];
export type JobOf<K extends JobKind> = Extract<Job, { kind: K }>;
