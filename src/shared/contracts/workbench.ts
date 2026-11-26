import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

/** `POST /workbench/token`: the org the token works in, Test only. Your sandbox, or an org you belong to. */
export const MintWorkbenchTokenSchema = z.strictObject({ orgId: IdSchema });
export type MintWorkbenchToken = z.infer<typeof MintWorkbenchTokenSchema>;

/** `DELETE /workbench/token`: ends this session's tokens for the org. */
export const EndWorkbenchTokenQuerySchema = z.object({ orgId: IdSchema });

/**
 * A 15-minute bearer for the Workbench, bound to this session and one org, Test only. `sandbox_key` acts as
 * your sandbox's key; `member` as you in the org's Test mode, on the operations marked `x-workbench: test`.
 * Send it as `Authorization: Bearer`, never with cookies or a mode header. Refresh at 12 minutes; keep it in
 * memory only, never in storage or a URL.
 */
export const WorkbenchTokenSchema = z.object({
  token: z.string(),
  orgId: IdSchema,
  mode: z.literal('test'),
  expiresAt: TimestampSchema,
  subject: z.enum(['sandbox_key', 'member']),
});
export type WorkbenchToken = z.infer<typeof WorkbenchTokenSchema>;

/**
 * The scopes a key made or rotated under a Workbench token may hold: Test data only. Brand, org, wallet,
 * member, key, audit, connection and NFC scopes reach state Live shares, so a token never mints them.
 */
export const WORKBENCH_KEY_SCOPES: readonly string[] = [
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
  'webhooks:manage',
  'scans:read',
];
/** A key made under a token must expire, at most this long after it is made (30 days). */
export const WORKBENCH_KEY_MAX_MS = 30 * 86_400_000;

/**
 * The operations a member token may call (`x-workbench: test` in the OpenAPI document): each one's effect
 * stays inside the org's Test mode. Deny by default: every other route answers 403 `WORKBENCH_TEST_ONLY`.
 * A sandbox token is its sandbox's key and needs no list, since a sandbox holds Test only.
 * Adding a route here needs a test that it neither reaches Live nor another org (`modules/workbench`).
 */
export const WORKBENCH_ROUTES: readonly string[] = [
  // Passes: list, inspect, issue, update and void Test passes.
  'GET /api/v1/passes',
  'POST /api/v1/passes',
  'GET /api/v1/passes/:id',
  'PATCH /api/v1/passes/:id',
  'POST /api/v1/passes/:id/void',
  'GET /api/v1/passes/:id/diff',
  'GET /api/v1/passes/:id/events',
  'GET /api/v1/passes/:id/devices',
  // Events, and the Connections wizard's outbound endpoints (Test-mode rows; DM2).
  'GET /api/v1/events',
  'GET /api/v1/events/:id',
  'GET /api/v1/webhook-endpoints',
  'POST /api/v1/webhook-endpoints',
  'GET /api/v1/webhook-endpoints/:id',
  'PATCH /api/v1/webhook-endpoints/:id',
  'DELETE /api/v1/webhook-endpoints/:id',
  'POST /api/v1/webhook-endpoints/:id/secret',
  'POST /api/v1/webhook-endpoints/:id/test',
  'GET /api/v1/webhook-endpoints/:id/tests',
  'GET /api/v1/webhook-endpoints/:id/deliveries',
  'GET /api/v1/webhook-endpoints/:id/deliveries/:eventId',
  'POST /api/v1/webhook-endpoints/:id/deliveries/:eventId/replay',
  'POST /api/v1/webhook-endpoints/:id/replay',
  'POST /api/v1/webhook-endpoints/capture',
  'GET /api/v1/webhook-endpoints/:id/captures',
  'GET /api/v1/webhook-endpoints/:id/captures/:captureId',
  'POST /api/v1/webhook-endpoints/:id/captures/:captureId/replay',
  'POST /api/v1/webhook-endpoints/:id/captures/secret',
  // The test inbox: what Test mode sent instead of mailing it.
  'GET /api/v1/test-inbox',
  'GET /api/v1/test-inbox/:id',
  'GET /api/v1/test-inbox/:id/html',
  'POST /api/v1/test-inbox/:id/send-to-me',
  // Test keys: list, make, inspect, rotate, retire and revoke. Live keys are not found.
  'GET /api/v1/api-keys',
  'POST /api/v1/api-keys',
  'GET /api/v1/api-keys/:id',
  'DELETE /api/v1/api-keys/:id',
  'POST /api/v1/api-keys/:id/rotate',
  'POST /api/v1/api-keys/:id/retire',
  'GET /api/v1/api-keys/:id/activity',
  // Activity and the tray: the org's Test operations the person may read, and stopping or retrying them.
  'GET /api/v1/operations',
  'GET /api/v1/operations/:id',
  'POST /api/v1/operations/:id/cancel',
  'POST /api/v1/operations/:id/retry',
  // Release a template version to Test only (`modes: ['test']`).
  'POST /api/v1/templates/:id/release',
];
