import { z } from 'zod';

/** The setup items in the order the card shows them. */
export const SETUP_ITEMS = [
  'binding',
  'polaris_settings',
  'client',
  'groups',
  'client_groups',
  'client_restricted',
  'client_logo',
  'scim_token',
  'scim_provider',
  'scim_sync',
  'scim_mirror',
  'write_mode',
] as const;
export const SetupItemKeySchema = z.enum(SETUP_ITEMS);
export type SetupItemKey = z.infer<typeof SetupItemKeySchema>;

/** The items a run acts on. `scim_provider` includes minting the token. */
export const SETUP_ACTIONS = [
  'groups',
  'client_groups',
  'client_restricted',
  'client_logo',
  'scim_provider',
  'scim_sync',
] as const;
export const SetupActionKeySchema = z.enum(SETUP_ACTIONS);
export type SetupActionKey = z.infer<typeof SetupActionKeySchema>;

/** One group on the card: a role group PassBook places, or an alias group (`allowed`) it only allows. */
export const SetupRowSchema = z.object({
  key: z.string(),
  state: z.enum(['placed', 'allowed', 'needed']),
});

export const SetupItemSchema = z.object({
  key: SetupItemKeySchema,
  /** `needed` with an `after:<key>` reason waits for that item. */
  status: z.enum(['done', 'needed', 'blocked']),
  /** A stable word such as `client_not_found` or `after:groups`; the card words it. */
  reason: z.string().optional(),
  /** Blocked on the PassBook owner, not on a retry. */
  owner: z.boolean().optional(),
  counts: z.record(z.string(), z.number().int()).optional(),
  rows: z.array(SetupRowSchema).optional(),
  /** `write_mode`: `dry_run` or `live`. */
  note: z.string().optional(),
});
export type SetupItem = z.infer<typeof SetupItemSchema>;

/** `GET /platform/idp/setup`. */
export const SetupStatusSchema = z.object({
  mode: z.enum(['dry_run', 'live']).nullable(),
  items: z.array(SetupItemSchema),
});

/** `POST /platform/idp/setup`: a dry run unless `dryRun` is false. `items` limits what it acts on. */
export const StartSetupSchema = z.strictObject({
  dryRun: z.boolean().default(true),
  items: z.array(SetupActionKeySchema).max(SETUP_ACTIONS.length).optional(),
});
export type StartSetup = z.infer<typeof StartSetupSchema>;

/** `POST /platform/idp/scim-token/rotate`. */
export const RotateScimSchema = z.strictObject({ dryRun: z.boolean().default(true) });
