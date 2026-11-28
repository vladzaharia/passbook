/** Extra statuses a code is raised with, beside its most common one: `CODE status file` (file relative to src/worker). Each is reviewed and deliberate (reason beside it); a new one fails error-catalog.test.ts until it is listed here, so first ask whether it should use the code's usual status or a new code.
 * IDEMPOTENCY_KEY_REUSED is 422 everywhere but the 409 kept for clients that have not pinned PassBook-Version 2026-11-22 (docs/api/versions.json). */
export const EXTRA_STATUS_SITES: readonly string[] = [
  // Missing X-Device header is a validation error; the live socket refusing a non-scanner is a 403.
  'DEVICE_REQUIRED 422 modules/scan/guard-api-key.ts',
  // Adding an address another account owns is a conflict; sign-in proving it refuses the claim (403).
  'EMAIL_TAKEN 409 modules/users/emails.ts',
  'IDEMPOTENCY_KEY_REUSED 409 modules/scan/routes-tags.ts',
  // A step that can never succeed is a 409 the workflow treats as permanent; the 502 steps retry.
  'IDENTITY_RUN_INCOMPLETE 409 modules/identities/provision-platform.ts',
  // Polaris ID's own refusal is 403; PassBook's rules on a role or adopted group are conflicts (409).
  'IDP_REFUSED 403 modules/idp/errors.ts',
  'IDP_REFUSED 403 modules/idp/setup-run.ts',
  // A run that is not in a retryable state is 409; a run id the server cannot parse is not found.
  'OPERATION_NOT_RETRYABLE 409 modules/operations/service-act.ts',
  // A scanner token that is revoked is 401; pairing a revoked scanner from the console is a conflict.
  'SCANNER_REVOKED 409 modules/scan/pairing-token.ts',
  // Scanner-facing refusals are 403 (the device stops); console actions on the same state are 409/422.
  'SCANNING_SESSION_CLOSED 409 modules/scan/session-hold.ts',
  'SCANNING_SESSION_PAUSED 403 modules/scan/guard-session-admits.ts',
  'SCANNING_SESSION_SETTINGS_INVALID 403 modules/scan/scanning-workspace.ts',
  // Undoing a scan in another mode is forbidden; assigning an event across modes is a validation error.
  'SCAN_MODE_MISMATCH 422 modules/scan/scanner-mode.ts',
  // An archived template named in a body field is a validation error; changing one is a conflict.
  'TEMPLATE_ARCHIVED 422 modules/scan/events-validation.ts',
  'TEMPLATE_ARCHIVED 422 modules/scan/scanner-validation.ts',
  // New content that fails validation is 422 with issues; releasing a stored invalid version is a conflict.
  'VERSION_INVALID 422 modules/templates/version-check.ts',
  // The 503 is the queue consumer asking for a retry; the replay route answers 409.
  'WEBHOOK_STALE_CONTEXT 409 modules/connections/webhook-replay.ts',
];
