import { z } from 'zod';
import { CREDENTIAL_SCOPES, MINTABLE_SCOPES, PLATFORM_KEY_SCOPES } from './api-keys.ts';
import { ApiScopeSchema, IdSchema, OrgIdSchema, TimestampSchema } from './common.ts';
import { RequestLogEntrySchema } from './developer.ts';
import { OrgRolesSchema } from './org-membership.ts';
import { WebhookEndpointStatusSchema } from './webhooks.ts';
import { QuotasSchema } from './workbench-read.ts';

/**
 * The scopes a sandbox key may hold: every mintable scope except minting keys, the terminal scope, the
 * Live-only scanning setup and the platform scopes. The sandbox key has all of them; a key made in the portal holds a subset.
 */
export const SANDBOX_KEY_SCOPES = MINTABLE_SCOPES.filter(
  (s) =>
    s !== 'api-keys:write' &&
    s !== 'scans:write' &&
    !(CREDENTIAL_SCOPES as readonly string[]).includes(s) &&
    !(PLATFORM_KEY_SCOPES as readonly string[]).includes(s),
);

const at = (text: string) => TimestampSchema.nullable().describe(text);
const count = z.number().int().nonnegative();

export const DeveloperHomeSandboxSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  orgSlug: z.string(),
  name: z.string(),
  templateId: IdSchema.nullable().describe('The quickstart ticket, released in Test.'),
  mode: z.literal('test').describe('A sandbox holds Test only.'),
  previewOnly: z.literal(true),
  createdAt: TimestampSchema,
  closedAt: at('Set when the sandbox closed.'),
  closeReason: z.enum(['idle', 'admin', 'user']).nullable(),
  reopenUntil: at('Closed: the end of the window in which it can reopen. Null while open.'),
  limits: z
    .object({
      passes: count.nullable(),
      templates: count.nullable(),
      endpoints: count.nullable(),
      keys: count.nullable(),
    })
    .describe("The sandbox plan's caps; null when the plan sets none."),
});
export type DeveloperHomeSandbox = z.infer<typeof DeveloperHomeSandboxSchema>;

/** The quickstart steps after sign-in, in order. `call` is done when a pass exists, made from a terminal or Run here. */
export const QUICKSTART_TRACK = ['sandbox', 'call', 'change', 'webhook'] as const;
export const QuickstartTrackStepSchema = z.enum(QUICKSTART_TRACK);

/**
 * The quickstart track, from the database. A reset restarts it (`startedAt` moves, the steps clear); the funnel's
 * first values stay.
 */
export const DeveloperProgressSchema = z.object({
  startedAt: TimestampSchema.describe(
    'When the clock started: the last reset, else the quickstart view, else the sandbox.',
  ),
  restartedAt: at('The last reset.'),
  sandboxAt: TimestampSchema.describe('The sandbox was made, or last reset.'),
  keyCallAt: at('First call below 400 with any sandbox key, not Run here.'),
  passAt: at('First Test pass, from a terminal or Run here.'),
  changeAt: at('First change to a Test pass.'),
  webhookAt: at('First event captured.'),
  doneAt: at('When the last of pass, change and webhook landed.'),
  doneMs: z.number().int().nonnegative().nullable().describe('doneAt minus startedAt.'),
  next: QuickstartTrackStepSchema.nullable().describe('The first step not done; null when done.'),
});
export type DeveloperProgress = z.infer<typeof DeveloperProgressSchema>;

export const DeveloperUsageSchema = z.object({
  calls24h: count,
  errors24h: count.describe('Calls answered 400 or above.'),
  captures24h: count,
  passes: count.describe('Test passes held, as the pass limit counts them.'),
  series: z
    .object({
      from: TimestampSchema.describe('Start of the first hour.'),
      calls: z.array(count).length(24),
      errors: z.array(count).length(24),
    })
    .describe('Calls and errors per hour, oldest first.'),
});
export type DeveloperUsage = z.infer<typeof DeveloperUsageSchema>;

export const DeveloperHomeKeySchema = z.object({
  id: IdSchema,
  name: z.string(),
  secretPrefix: z.string().describe('The start of the secret. The rest is never stored.'),
  scopes: z.array(ApiScopeSchema),
  createdAt: TimestampSchema,
  expiresAt: at('Null: never.'),
  lastUsedAt: at('Last call.'),
  retireAt: at('Set while a roll overlaps: the key stops then.'),
  sandboxKey: z.boolean().describe('The key the sandbox made.'),
});
export type DeveloperHomeKey = z.infer<typeof DeveloperHomeKeySchema>;

export const DeveloperHomeEndpointSchema = z.object({
  id: IdSchema,
  target: z.enum(['capture', 'url']).describe('capture: stored here, never sent.'),
  url: z.string().nullable().describe('Null for the capture endpoint.'),
  status: WebhookEndpointStatusSchema,
  eventTypes: z.array(z.string()),
  lastAt: at('Last capture or delivery attempt.'),
  lastOk: z.boolean().nullable().describe('Whether that one succeeded.'),
});
export type DeveloperHomeEndpoint = z.infer<typeof DeveloperHomeEndpointSchema>;

export const DeveloperHomePassSchema = z.object({
  id: IdSchema,
  templateId: IdSchema,
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  status: z.enum(['active', 'voided']),
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  modifiedAt: TimestampSchema,
  previewUrl: z.string().describe('The TEST preview page: public, never installable.'),
});
export type DeveloperHomePass = z.infer<typeof DeveloperHomePassSchema>;

export const DeveloperLiveOrgSchema = z.object({
  orgId: OrgIdSchema,
  name: z.string(),
  slug: z.string(),
  roles: OrgRolesSchema,
  canMintLive: z.boolean().describe('Can make a Live personal key there, in Admin.'),
});
export type DeveloperLiveOrg = z.infer<typeof DeveloperLiveOrgSchema>;

/**
 * `GET /developer/home`: the signed-in developer's workbench. `none`: no sandbox yet, so only `liveOrgs` is filled.
 * `closed`: read-only; its keys are revoked.
 */
export const DeveloperHomeSchema = z.object({
  now: TimestampSchema.describe('Server time. Count clocks from it, not the device clock.'),
  state: z.enum(['none', 'open', 'closed']),
  sandbox: DeveloperHomeSandboxSchema.nullable(),
  progress: DeveloperProgressSchema.nullable(),
  usage: DeveloperUsageSchema.nullable(),
  quotas: QuotasSchema.nullable().describe('What the sandbox holds against its caps.'),
  keys: z.array(DeveloperHomeKeySchema).describe('Not revoked and not retired, newest first.'),
  calls: z
    .array(RequestLogEntrySchema)
    .describe('The 8 latest calls, any source. The first id is the listener cursor (`after`).'),
  endpoints: z.array(DeveloperHomeEndpointSchema).describe('The capture endpoint first.'),
  passes: z.array(DeveloperHomePassSchema).describe('The 3 latest Test passes.'),
  liveOrgs: z
    .array(DeveloperLiveOrgSchema)
    .describe('Your organizations that hold Live: where Live keys come from.'),
});
export type DeveloperHome = z.infer<typeof DeveloperHomeSchema>;
