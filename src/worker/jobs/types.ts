import { z } from 'zod';
import { ConnectionModeSchema } from '../../shared/contracts/connections.ts';

/** Every queue message. Add a kind here, to JOB_HANDLERS in registry.ts, and implement it in the owning module. */
export const JobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('push.deliver'), outboxId: z.string() }),
  z.object({ kind: z.literal('email.send'), outboxId: z.string() }),
  z.object({
    kind: z.literal('pass.refresh'),
    passId: z.string(),
    orgId: z.string(),
    identityId: z.string().min(1),
    templateId: z.string().min(1),
    templateVersion: z.string().min(1),
    releaseId: z.string().min(1).nullable(),
    mode: z.enum(['live', 'test']),
    passVersion: z.number().int().positive(),
    status: z.enum(['active', 'voided']),
    ownerUserId: z.string().nullable(),
    linkGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    lifecycleGeneration: z.number().int().nonnegative(),
    credentialKeysetCommitment: z.string().regex(/^[0-9a-f]{64}$/),
    connectionId: z.string().nullable(),
    externalRef: z.string().nullable(),
    generation: z.number().int().positive().nullable(),
    connectionMode: ConnectionModeSchema.nullable(),
    trigger: z.enum(['admin', 'user']),
    actorId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('connection.webhook'),
    connectionId: z.string(),
    orgId: z.string(),
    generation: z.number().int().positive(),
    // Absent only on messages that predate keyset binding; processWebhook never stages those.
    credentialKeysetCommitment: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    eventId: z.string(),
    refs: z.array(z.string()),
    // Position of this chunk in its event; part of the chunk's identity. Absent means 0.
    chunk: z.number().int().nonnegative().optional(),
  }),
]);

export type Job = z.infer<typeof JobSchema>;
export type JobKind = Job['kind'];
export type JobOf<K extends JobKind> = Extract<Job, { kind: K }>;
/** New webhook producers must bind the original keyset; only the wire decoder accepts legacy jobs. */
export type NewConnectionWebhookJob = JobOf<'connection.webhook'> & {
  credentialKeysetCommitment: string;
};

/**
 * Messages the pre-cutover Worker may still have queued. They carry no tenant binding, so they are
 * never run: the consumer logs them, retains a connection.webhook as ignored, and acknowledges.
 */
export const LegacyJobSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('connection.webhook'),
      connectionId: z.string(),
      eventId: z.string(),
      refs: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pass.refresh'),
      passId: z.string(),
      trigger: z.string(),
      actorId: z.string().nullable(),
    })
    .strict(),
]);
export type LegacyJob = z.infer<typeof LegacyJobSchema>;
