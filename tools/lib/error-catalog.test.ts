import { describe, expect, it } from 'vitest';
import { errorStatuses } from '../../src/web/developers/model/error-status.ts';
import { buildErrorCatalog } from './error-catalog.ts';

/** Each multi-status code with the status raised at the most sites; a tie goes to the lower status. */
const COMMON: Record<string, number> = {
  API_KEY_NOT_FOUND: 404,
  ASSET_SIZE: 413,
  DEVICE_REQUIRED: 403,
  EMAIL_CONFLICT: 403,
  EMAIL_TAKEN: 403,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDENTITY_NOT_FOUND: 404,
  IDENTITY_RUN_INCOMPLETE: 502,
  NO_RECIPIENT: 422,
  ORG_INACTIVE: 403,
  ORG_NOT_FOUND: 404,
  ORG_REQUIRED: 422,
  SCANNER_NOT_FOUND: 404,
  SCANNER_REVOKED: 401,
  SCANNING_SESSION_CLOSED: 403,
  SCANNING_SESSION_PAUSED: 409,
  SCANNING_SESSION_SETTINGS_INVALID: 422,
  SCAN_MODE_MISMATCH: 403,
  TAG_NOT_FOUND: 404,
  TEMPLATE_ARCHIVED: 409,
  TEMPLATE_NOT_FOUND: 404,
  UPSTREAM: 429,
  VALIDATION: 422,
  VERSION_INVALID: 409,
  VISITOR_HOST_UNKNOWN: 403,
  WEBHOOK_STALE_CONTEXT: 409,
  WORKFLOW_START: 503,
};

describe('error catalog statuses', () => {
  const catalog = buildErrorCatalog();

  it('shows a multi-status code with its most common raise site', () => {
    const multi = catalog.codes.filter((c) => c.statuses.length > 1);
    expect(Object.fromEntries(multi.map((c) => [c.code, c.statuses[0]]))).toEqual(COMMON);
    expect(multi).toHaveLength(27);
  });

  it('keeps every status for display', () => {
    const reused = catalog.codes.find((c) => c.code === 'IDEMPOTENCY_KEY_REUSED');
    expect([...(reused?.statuses ?? [])].sort()).toEqual([409, 422]);
  });

  it('the reference reads the first status', () => {
    expect(errorStatuses(catalog).get('IDEMPOTENCY_KEY_REUSED')).toBe(422);
  });
});
