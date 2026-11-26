import { z } from 'zod';
import { ChannelSchema } from '../../shared/contracts/channels.ts';
import { ModeSchema } from '../../shared/contracts/common.ts';
import { ConnectionModeSchema } from '../../shared/contracts/connections.ts';
import { RETENTION_CLASSES } from '../../shared/privacy/data-classes.ts';

/** Every queue message. Add a kind here, to JOB_HANDLERS in registry.ts, and implement it in the owning module. */
export const JobSchema = z.discriminatedUnion('kind', [
  /** Runs an operation's kind hook: the delayed backstop of an in-request run, a retry, a stall resend. */
  z.object({
    kind: z.literal('operation.run'),
    operationId: z.string().min(1).max(64),
    attempt: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('push.deliver'), outboxId: z.string() }),
  z.object({ kind: z.literal('email.send'), outboxId: z.string() }),
  z.object({ kind: z.literal('join.resend'), passId: z.string(), linkId: z.string() }),
  /** A guest pass's window inputs changed: its lent tags end with the new window. */
  z.object({ kind: z.literal('tags.lent_window'), passId: z.string(), orgId: z.string() }),
  z.object({
    kind: z.literal('webhook.deliver'),
    endpointId: z.string(),
    orgId: z.string(),
    mode: ModeSchema,
    lane: z.string(),
  }),
  z.object({ kind: z.literal('message_rule.check'), ruleId: z.string(), at: z.number() }),
  /** A holder asked for their own pass by email (Send it again, I lost my phone). */
  z.object({
    kind: z.literal('pass.holder_mail'),
    passId: z.string(),
    /** The signed-in owner; null when the holder used the pass link. */
    userId: z.string().nullable(),
    reason: z.enum(['resend', 'lost_phone', 'codes_replaced', 'channel_off']),
    /** The holder's operation that reports this mail (resend, lost phone). */
    operationId: z.string().min(1).max(64).optional(),
    /** channel_off: the digital channels whose copies stopped working, for the mail's line. */
    channels: z.array(z.enum(['mobile', 'apple', 'google', 'samsung'])).optional(),
  }),
  /** Tells an org's admins that a retention class shortens. One job per org and class. */
  z.object({
    kind: z.literal('retention.notice'),
    orgId: z.string(),
    cls: z.enum(RETENTION_CLASSES),
    days: z.number().int().positive(),
    from: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('pass.refresh'),
    /** The holder's operation that reports this refresh; absent for an admin's. */
    operationId: z.string().min(1).max(64).optional(),
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
  /** A platform admin's hold on a suspended org's wallet enrolment: a job grant writes it. */
  /** One legacy wallet account onto its credential source, under the migrate job grant. */
  z.object({ kind: z.literal('wallet.credential_migrate'), accountId: z.string().min(1) }),
  /** One managed Google issuer run (adopt or insert the issuer, record it on the org). */
  z.object({ kind: z.literal('wallet.google_issuer'), runId: z.string().min(1).max(64) }),
  /** One service-account key rotation run of a platform Google credential. */
  z.object({ kind: z.literal('wallet.google_key_rotate'), runId: z.string().min(1).max(64) }),
  /** An Apple release published: the platform authors the provider candidate (CW7b). */
  z.object({
    kind: z.literal('wallet.projection_system'),
    orgId: z.string().min(1),
    mode: ModeSchema,
    templateId: z.string().min(1),
    sourceReleaseId: z.string().min(1),
    version: z.string().min(1),
    provider: z.enum(['google', 'samsung']),
  }),
  z.object({
    kind: z.literal('wallet.enrolment_hold'),
    orgId: z.string().min(1),
    mode: ModeSchema,
    provider: z.enum(['google', 'samsung']),
    reason: z.string().min(1).max(500),
    userId: z.string().min(1),
  }),
  /** A credential's health check: the provider probe and its server-clock row. `checkId` names the result. */
  z.object({
    kind: z.literal('wallet.credential_check'),
    credentialId: z.string().min(1).max(64),
    checkId: z.string().min(1).max(80),
  }),
  /** A Google release was published: bring the classes of its template's earlier releases up to it. */
  z.object({
    kind: z.literal('wallet.google_reconcile'),
    orgId: z.string().min(1).max(64),
    mode: ModeSchema,
    templateId: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    generation: z.number().int().positive(),
    /** Where the last run stopped (a class id hash), and how many runs this publish has used. */
    after: z.string().max(64).optional(),
    runs: z.number().int().nonnegative().optional(),
  }),
  /** A wallet reissue: send every active Google or Samsung copy of the org's passes again. */
  z.object({
    kind: z.literal('wallet.reissue'),
    reissueId: z.string().min(1).max(64),
    orgId: z.string().min(1).max(64),
    mode: ModeSchema,
    provider: z.enum(['google', 'samsung']),
    templateId: z.string().min(1).max(64).optional(),
    /** Where the last run stopped (an instance id, exclusive); the copy after it is the first this run takes. */
    after: z.string().max(64).optional(),
    /** The copy that failed the last run and how many times it has: a copy is retried, then skipped, never lost. */
    failedId: z.string().max(64).optional(),
    failures: z.number().int().nonnegative().optional(),
    /** The operation that shows this run, its attempt, the copies it reaches, and how many are behind it. */
    operationId: z.string().min(1).max(64).optional(),
    attempt: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
    done: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
  }),
  /** A claim found a release's wallet art missing: cut and store it again, as publication did. */
  z.object({ kind: z.literal('wallet.google_art'), candidateId: z.string().min(1).max(64) }),
  /** An event boundary of the pass passed: work out its timed keys. `lease` is the claim's due time. */
  z.object({
    kind: z.literal('pass.boundary_refresh'),
    passId: z.string().min(1),
    lease: z.number().int().positive(),
  }),
  /** Apple flipped for a pass: republish (force) so devices fetch the voided or live copy. */
  z.object({
    kind: z.literal('channel.apple_bump'),
    passId: z.string().min(1),
    /** The pass version read after the channel change committed: a later publish already covers it. */
    version: z.number().int().positive(),
  }),
  /** A republish changed which wallets the pass's template version can serve: retire or restore the channels. */
  z.object({
    kind: z.literal('channel.capability'),
    passId: z.string().min(1),
    /** The template version the pass was on before the publish. */
    previousVersion: z.string().min(1),
  }),
  /** An org's plan changed which delivery channels it includes: converge its passes, one apply run per template. */
  z.object({
    kind: z.literal('channel.entitlement'),
    orgId: z.string().min(1),
    /** The entitlement revision this change made: the runs it opens are keyed on it. */
    revision: z.number().int().positive(),
    /** The channels the plan blocked before the change, and after it. */
    blockedBefore: z.array(ChannelSchema),
    blockedAfter: z.array(ChannelSchema),
    /** A full reconcile (an org left behind by a preset edit): stop what the plan blocks, resume what it allows. */
    full: z.boolean().optional(),
    requestedBy: z.string().min(1),
  }),
  /** A bulk "turn off and replace codes": the pass gets a new scan code once its windows are closed. */
  z.object({
    kind: z.literal('channel.replace_code'),
    passId: z.string().min(1),
    /** The idempotency key and rotation actor id: `channel_bulk:{requestId}`. */
    key: z.string().min(1),
    /** The operation that shows this replacement, and its attempt. */
    operationId: z.string().min(1).max(64).optional(),
    attempt: z.number().int().positive().optional(),
  }),
  /** One combined PDF of staff prints (bulk Print). The prints already exist; the job only renders. */
  z.object({
    kind: z.literal('prints.bulk'),
    orgId: z.string().min(1),
    jobId: z.string().min(1),
    passIds: z.array(z.string().min(1)).min(1).max(50),
    /** The operation that shows this job, and its attempt. */
    operationId: z.string().min(1).max(64).optional(),
    attempt: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('template.fork_update'),
    updateId: z.string().min(1),
    templateId: z.string().min(1),
    orgId: z.string().min(1),
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
