import { eligibleTemplate, ORG, SAMPLE_PASS_JSON, templateDetail } from '../test-fixtures.ts';

export { ORG };

/** A PassImport as the API sends it; `over` replaces fields. */
export function importDto(over: Record<string, unknown> = {}) {
  return {
    id: 'imp1',
    templateId: 'tpl1',
    templateVersion: 'a1b2c3d4e5f6a7b8',
    mode: 'live',
    state: 'mapping',
    source: { kind: 'file', name: 'people.csv' },
    columns: [
      { pointer: '/Name', label: 'Name', samples: ['Maya', 'Jo'] },
      { pointer: '/Level', label: 'Level', samples: ['blue'] },
      { pointer: '/Email', label: 'Email', samples: ['maya@example.com'] },
      { pointer: '/Id', label: 'Id', samples: ['A1'] },
    ],
    plan: null,
    counts: null,
    previews: [],
    problems: [],
    problemTotals: { errors: 0, warnings: 0 },
    problemsTruncated: false,
    emailBudget: null,
    email: false,
    progress: null,
    errorCode: null,
    errorFile: false,
    createdAt: 1_700_000_000_000,
    checkedAt: null,
    committedAt: null,
    finishedAt: null,
    expiresAt: 4_000_000_000_000,
    ...over,
  };
}

export const PLAN = {
  mapping: { name: { from: '/Name' } },
  holderEmail: { from: '/Email' },
  externalId: { from: '/Id' },
  match: 'externalId',
  keepManual: false,
  save: true,
};

export const COUNTS = {
  rows: 160,
  create: 120,
  update: 40,
  unchanged: 12,
  errors: 3,
  warnings: 1,
  emailable: 100,
};

export const checked = (over: Record<string, unknown> = {}) =>
  importDto({
    state: 'ready',
    plan: PLAN,
    counts: COUNTS,
    checkedAt: 1_700_000_000_500,
    emailBudget: 80,
    errorFile: true,
    previews: [
      { row: 2, action: 'create', input: { name: 'Maya' } },
      { row: 3, action: 'update', input: { name: 'Jo' } },
    ],
    problems: [
      {
        row: 14,
        column: 'Email',
        field: null,
        code: 'EMAIL_INVALID',
        value: 'bad@',
        message: 'Email is not valid.',
        severity: 'error',
      },
      {
        row: 9,
        column: 'Points',
        field: 'points',
        code: 'IMPORT_MANUAL_KEPT',
        message: 'Points was edited in PassBook; left as is.',
        severity: 'warning',
      },
    ],
    problemTotals: { errors: 3, warnings: 1 },
    ...over,
  });

export const finished = (over: Record<string, unknown> = {}) =>
  importDto({
    state: 'done',
    plan: PLAN,
    counts: { ...COUNTS, errors: 0 },
    committedAt: 1_700_000_001_000,
    finishedAt: 1_700_000_002_000,
    progress: {
      done: 160,
      created: 120,
      updated: 40,
      unchanged: 12,
      failed: 0,
      skipped: 0,
      notEmailed: 0,
      removed: 0,
    },
    ...over,
  });

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The reads every screen needs; each test adds the import routes it uses. */
export function baseHandlers() {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/tpl1/preview': () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
    '/api/v1/pass-imports': () => json({ items: [], nextCursor: null }),
  };
}
