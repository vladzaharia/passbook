import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorStatuses, errorStatusLabels } from '../../src/web/developers/model/error-status.ts';
import { isInternalCode } from '../../src/worker/platform/internal-codes.ts';
import { buildErrorCatalog, type RaiseSite } from './error-catalog.ts';
import { EXTRA_STATUS_SITES } from './error-status-sites.ts';

/** Each multi-status code with the status shown first: raised at the most sites; on a tie the 5xx when the tie spans 4xx and 5xx, else the lower. */
const COMMON: Record<string, number> = {
  API_KEY_NOT_FOUND: 404,
  ASSET_SIZE: 413,
  DEVICE_REQUIRED: 403,
  EMAIL_CONFLICT: 403,
  EMAIL_TAKEN: 403,
  FILE_DAMAGED: 500,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDENTITY_NOT_FOUND: 404,
  IDENTITY_RUN_INCOMPLETE: 502,
  IDP_REFUSED: 409,
  NO_RECIPIENT: 422,
  OPERATION_NOT_RETRYABLE: 404,
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
  VERSION_INVALID: 409,
  WEBHOOK_STALE_CONTEXT: 503,
  WORKFLOW_START: 503,
};

/** The statuses tied for most common raise site. */
const TIES: Record<string, number[]> = {
  ASSET_SIZE: [413, 422],
  EMAIL_TAKEN: [403, 409],
  FILE_DAMAGED: [422, 500],
  OPERATION_NOT_RETRYABLE: [404, 409],
  ORG_INACTIVE: [403, 409],
  SCANNER_REVOKED: [401, 409],
  SCANNING_SESSION_CLOSED: [403, 409],
  SCAN_MODE_MISMATCH: [403, 422],
  WEBHOOK_STALE_CONTEXT: [409, 503],
};

describe('error catalog statuses', () => {
  const catalog = buildErrorCatalog();
  const multi = catalog.codes.filter((c) => c.statuses.length > 1);

  it('shows a multi-status code with its most common raise site', () => {
    expect(Object.fromEntries(multi.map((c) => [c.code, c.statuses[0]]))).toEqual(COMMON);
    expect(multi).toHaveLength(27);
  });

  it('carries the tied set where raise sites tie', () => {
    expect(
      Object.fromEntries(multi.filter((c) => c.primary).map((c) => [c.code, c.primary])),
    ).toEqual(TIES);
    expect(catalog.codes.filter((c) => c.statuses.length === 1 && c.primary)).toEqual([]);
  });

  it('raises a second status only at a listed site', () => {
    const sites: RaiseSite[] = [];
    const codes = buildErrorCatalog(sites).codes.filter((c) => c.statuses.length > 1);
    const extras = new Set(
      codes.flatMap((c) =>
        sites
          .filter((s) => s.code === c.code && s.status !== c.statuses[0])
          .map((s) => `${s.code} ${s.status} ${s.file}`),
      ),
    );
    expect([...extras].sort()).toEqual([...EXTRA_STATUS_SITES].sort());
  });

  it('keeps every status for display', () => {
    const reused = catalog.codes.find((c) => c.code === 'IDEMPOTENCY_KEY_REUSED');
    expect([...(reused?.statuses ?? [])].sort()).toEqual([409, 422]);
  });

  it('does not read a default code across class bodies', () => {
    const get = (code: string) => catalog.codes.find((c) => c.code === code)?.statuses;
    expect(get('UPSTREAM')).toEqual([502]);
    expect(get('VALIDATION')).toEqual([422]);
  });

  it('the reference reads the first status, and says "or" for a tie', () => {
    expect(errorStatuses(catalog).get('IDEMPOTENCY_KEY_REUSED')).toBe(422);
    expect(errorStatusLabels(catalog).get('WEBHOOK_STALE_CONTEXT')).toBe('409 or 503');
    expect(errorStatusLabels(catalog).has('IDEMPOTENCY_KEY_REUSED')).toBe(false);
  });
});

const WORKER = resolve(import.meta.dirname, '../../src/worker');
const sources = (dir: string): { path: string; src: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
      ? [{ path: p, src: readFileSync(p, 'utf8') }]
      : [];
  });

/** Error classes that never become a response: connector reasons, NFC protocol, template-archive parse errors and an internal RangeError. */
const NOT_HTTP = [
  '/connectors/',
  '/ntag424/',
  '/templates/version-files.ts',
  '/templates/package/',
  '/webhooks/payload.ts',
];

describe('error catalog coverage', () => {
  it('lists every code a worker error class or `new XError(...)` names', () => {
    const catalog = new Set(buildErrorCatalog().codes.map((c) => c.code));
    const missing = new Set<string>();
    for (const { path, src } of sources(WORKER)) {
      if (NOT_HTTP.some((part) => path.includes(part))) continue;
      for (const call of src.matchAll(/(?:\bsuper|new \w+Error)\(([^;]*?)\);/g))
        for (const lit of (call[1] ?? '').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) {
          const code = lit[1] ?? '';
          if (!catalog.has(code) && !isInternalCode(code)) missing.add(code);
        }
    }
    expect([...missing].sort()).toEqual([]);
  });

  it('carries the platform key codes, raised through super() and a literal', () => {
    const catalog = new Set(buildErrorCatalog().codes.map((c) => c.code));
    for (const code of [
      'PERSON_REQUIRED',
      'PLATFORM_KEY_REQUIRED',
      'API_KEY_PLATFORM_LIVE',
      'API_KEY_PLATFORM_SCOPES_ALONE',
      'API_KEY_PLATFORM_SCOPE_KIND',
    ])
      expect(catalog.has(code)).toBe(true);
  });
});
