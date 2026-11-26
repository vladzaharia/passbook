import { z } from 'zod';

export const IdSchema = z.string().min(1).max(64);
export const OrgIdSchema = IdSchema;
export const EmailSchema = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase().normalize('NFC'))
  .pipe(z.email());
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** One line of display text that may reach a mail header: no controls, line separators or bidi marks. */
export const PlainLineSchema = (max: number) =>
  z
    .string()
    .trim()
    .normalize()
    .min(1)
    .max(max)
    .refine((value) => !NOT_PLAIN.test(value), 'Use plain text on one line.');
/** Milliseconds since the epoch. */
export const TimestampSchema = z.number().int().nonnegative();
/** Any JSON value. Not recursive on purpose: recursive schemas break OpenAPI generation. */
export const JsonSchema = z.any() as z.ZodType<Json>;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  requestId: z.string().optional(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
    .optional(),
  /** FEATURE_NOT_INCLUDED: the entitlement key the organization lacks. */
  feature: z.string().optional(),
  /** FEATURE_LIMIT_REACHED: the cap and the count the organization holds. */
  limit: z.number().int().optional(),
  used: z.number().int().optional(),
  /** IDP_SIGN_IN_REQUIRED: where to sign in with Polaris ID. */
  signInUrl: z.string().optional(),
  /** OPERATION_RUNNING: the operation already doing this. */
  operationId: z.string().optional(),
});
export type ProblemDto = z.infer<typeof ProblemSchema>;

export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const IdParamSchema = z.object({ id: IdSchema });
export const OkSchema = z.object({ ok: z.literal(true) });

export const ApiScopeSchema = z.enum([
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
  'messages:write',
  'scans:read',
  /** Acts as a named terminal of the key's own org (`x-passbook-device`), Desk at most. */
  'scans:write',
  'connections:read',
  'connections:write',
  /** Manages the org's outbound webhook endpoints (`integrations:manage` for a session). */
  'webhooks:manage',
  // Reserved up front so per-area packages never edit this list. No route accepts them until its
  // area declares them (`RouteSpec.auth`); `worker/platform/api-scopes.ts` maps each to a capability.
  'templates:write',
  'templates:review',
  'templates:publish',
  'messages:read',
  'scanning:write',
  /** Reads the org's managed scanner and screen setups (`/api/v1/scan-setups`). */
  'scan-setup:read',
  /** Reserved: setup writes need a user creator, so no key route accepts it yet. */
  'scan-setup:write',
  /** Staff PINs and paired devices (codes shown once) in the one-call setup: org-bound, live keys only. */
  'scanning:admin',
  /** Secure tag keysets: list, create, rotate, retire, revoke, re-enrol, disable, import. Org-bound, live keys only. */
  'nfc:keys',
  'nfc:read',
  'nfc:write',
  'wallet:read',
  'wallet:write',
  'api-keys:write',
  'org:read',
  'org:write',
  'members:read',
  'members:write',
  'audit:read',
  /** Platform scopes: only a platform admin acts on them, never an org member or an org key. `platform:read` covers every GET of a key-callable platform route. */
  'platform:read',
  'platform:orgs',
  'platform:users',
  'platform:identities',
  'platform:wallet',
  'platform:settings',
  'platform:status',
  'platform:templates',
  'platform:audit',
  /** Reads and edits custom claims on Polaris ID users and groups. */
  'platform:claims',
  /** Creates and edits Polaris ID groups, their org rules and manual members. */
  'platform:groups',
  /** Reads and edits the org's brand kit: web logo, accent, mark level. */
  'brand:manage',
]);
/** `developer` and `console` come from the Pocket ID developer and admin groups; platform admins have both implied. */
export const RoleSchema = z.enum(['admin', 'user', 'developer', 'console']);

/** Sandbox: test passes, keys and events never mix with live ones in lists or metrics. */
export const ModeSchema = z.enum(['live', 'test']);
export type Mode = z.infer<typeof ModeSchema>;
/** Admin sessions pick a mode with this header; anything but `test` means live. */
export const MODE_HEADER = 'x-passbook-mode';

/** Lists that return everything at once still take `cursor`, so a client can page every list the same way. */
export const CursorQuerySchema = z.object({ cursor: z.string().max(512).optional() });
