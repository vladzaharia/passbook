import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

/** The characters of a user code: no vowels, no look-alikes. 20^8 is about 2^34.6 codes. */
export const CLI_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CLI_CODE_LENGTH = 8;
/** A pending code lives 10 minutes at most. */
export const CLI_CODE_TTL_S = 600;
export const CLI_POLL_INTERVAL_S = 5;
/** A CLI token lives 30 days, or 7 days idle. */
export const CLI_TOKEN_TTL_MS = 30 * 86_400_000;
export const CLI_TOKEN_IDLE_MS = 7 * 86_400_000;

/** `XXXX-XXXX` upper-cased from what a person typed: dashes and spaces dropped, 8 letters of the alphabet, else null. */
export function normalizeCliCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return code.length === CLI_CODE_LENGTH && [...code].every((ch) => CLI_CODE_ALPHABET.includes(ch))
    ? code
    : null;
}
export const showCliCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const Reported = z.string().trim().min(1).max(64);
/** What the device says about itself. Untrusted: shown as text, "reported by the device". */
export const CliClientSchema = z.strictObject({
  name: Reported,
  version: Reported,
  os: Reported,
  hostname: Reported.optional(),
});
export type CliClient = z.infer<typeof CliClientSchema>;

/** `POST /cli/sessions`: no auth. `accountHint` is the user id of the CLI's stored profile on a re-login. */
export const StartCliSessionSchema = z.strictObject({
  client: CliClientSchema,
  accountHint: IdSchema.optional(),
});

export const CliSessionStartedSchema = z.object({
  deviceCode: z.string().describe('Secret. Poll with it; never put it in a URL.'),
  userCode: z.string().describe('Shown as XXXX-XXXX. The person types it at verificationUri.'),
  verificationUri: z.string().url().describe('Absolute. Carries no code.'),
  expiresIn: z.number().int(),
  interval: z.number().int().describe('Seconds between polls.'),
});

/** `POST /cli/sessions/lookup`: the typed code; a session and CSRF. */
export const LookupCliCodeSchema = z.strictObject({ userCode: z.string().min(1).max(32) });

export const CliSessionReviewSchema = z.object({
  id: IdSchema,
  client: CliClientSchema,
  startedAt: TimestampSchema,
  startCountry: z.string().nullable(),
  startCity: z.string().nullable(),
  mismatch: z.boolean().describe('The approving network differs from the starting one.'),
  account: z.object({ id: IdSchema, name: z.string(), email: z.string() }),
  accountMismatch: z.boolean().describe('The device asked for another account.'),
});

/** `POST /cli/sessions/{id}/approve`: the context the token reaches: the sandbox, or an org's Test. */
export const ApproveCliSchema = z.strictObject({ orgId: IdSchema });

/** `POST /cli/sessions/token` and `DELETE`: the device code, in the body. */
export const CliTokenPollSchema = z.strictObject({ deviceCode: z.string().min(20).max(128) });

export const CliTokenSchema = z.object({
  token: z.string().describe('pbcli_test_…, shown once. Test only.'),
  tokenId: IdSchema,
  orgId: IdSchema,
  context: z.object({ kind: z.enum(['sandbox', 'org']), name: z.string() }),
  account: z.object({ name: z.string(), email: z.string() }),
  expiresAt: TimestampSchema,
  origin: z.string().url().describe('The origin that issued it; send it there only.'),
});
export type CliToken = z.infer<typeof CliTokenSchema>;

/** `POST /platform/cli-tokens/revoke`: the kill switch. Every CLI token, or those of one org or person. */
export const RevokeCliTokensSchema = z.strictObject({
  orgId: IdSchema.optional(),
  userId: IdSchema.optional(),
});
export const RevokedCliTokensSchema = z.object({ revoked: z.number().int() });

/**
 * The routes a CLI token may call (`x-workbench: cli`): what `passbook` calls, a subset of `WORKBENCH_ROUTES`,
 * plus its own logout. Deny by default; never a credential, `/api-keys/**` or step-up route.
 */
export const CLI_ROUTES: readonly string[] = [
  // trigger and passes: the Test passes the CLI sends events for.
  'GET /api/v1/passes',
  'POST /api/v1/passes',
  'GET /api/v1/passes/:id',
  'PATCH /api/v1/passes/:id',
  'POST /api/v1/passes/:id/simulate',
  // logs --follow, and open.
  'GET /api/v1/request-logs',
  'GET /api/v1/request-logs/:id',
  'GET /api/v1/resolve',
  // listen and forward: the capture endpoint, its captures and the events they carry.
  'POST /api/v1/webhook-endpoints/capture',
  'GET /api/v1/webhook-endpoints/:id/captures',
  'GET /api/v1/webhook-endpoints/:id/captures/:captureId',
  'POST /api/v1/webhook-endpoints/:id/captures/secret',
  'GET /api/v1/events',
  'GET /api/v1/events/:id',
  // types: a template's input schema.
  'GET /api/v1/templates/:id',
  'GET /api/v1/templates/:id/input-schema',
];

/** The one `/cli` route a token calls: `passbook logout` ends the token itself. */
export const CLI_LOGOUT_ROUTE = 'DELETE /api/v1/cli/tokens/:id';
