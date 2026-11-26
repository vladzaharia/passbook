import { CONNECTOR } from '../../passes/test-fixtures.ts';

export const UPLOAD_CONNECTOR = {
  ...CONNECTOR,
  type: 'file-upload',
  displayName: 'File upload',
  description: 'Keep passes in sync with a CSV, Excel or JSON file you upload.',
  capabilities: {
    poll: false,
    delta: false,
    webhook: false,
    import: false,
    snapshot: false,
    upload: true,
  },
  configSchema: {
    type: 'object',
    required: ['idColumn'],
    properties: { idColumn: { type: 'string', 'x-label': 'ID column' } },
  },
  secretSchema: null,
  recipes: [],
};

const col = (label: string, samples: string[], over: Record<string, unknown> = {}) => ({
  pointer: `/${label}`,
  label,
  type: 'text',
  samples,
  blanks: 0,
  duplicates: 0,
  ...over,
});

/** A parsed draft of a members file. */
export function draftFile(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    orgId: 'org1',
    state: 'draft',
    name: 'members.csv',
    format: 'csv',
    sheets: [],
    sheet: null,
    recordsPointer: null,
    bytes: 2048,
    rows: 412,
    columns: [
      col('Member ID', ['M-1', 'M-2', 'M-3']),
      col('Name', ['Maya', 'Noor', 'Ola'], { blanks: 3 }),
      col('Email', ['maya@example.com', 'noor@example.com', 'ola@example.com']),
    ],
    preview: {
      header: ['Member ID', 'Name', 'Email'],
      rows: [
        ['M-1', 'Maya', 'maya@example.com'],
        ['M-2', 'Noor', 'noor@example.com'],
      ],
    },
    idCandidates: ['/Member ID', '/Email'],
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_082_800_000,
    ...over,
  };
}

/** One revision of a connection's file. */
export function revision(over: Record<string, unknown> = {}) {
  return {
    id: 'f2',
    connectionId: 'c1',
    revision: 2,
    state: 'pending',
    name: 'members-nov.csv',
    format: 'csv',
    sheet: null,
    bytes: 4096,
    rows: 430,
    skipped: { noId: 0, duplicate: 0 },
    diff: {
      added: 12,
      changed: 30,
      removed: 3,
      examples: {
        added: ['M-413', 'M-414'],
        changed: ['M-7'],
        removed: ['M-12', 'M-98', 'M-101'],
      },
    },
    applied: false,
    createdBy: 'u1',
    createdByName: 'Maya Chen',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_082_800_000,
    supersededAt: null,
    ...over,
  };
}
