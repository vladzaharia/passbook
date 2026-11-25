// Hand-written examples of the connection file operations: a member sheet uploaded, then a changed one.
import { IDS, MEMBERS_CSV, T } from './example-world.ts';

const HOUR = 3_600_000;
const upload = { name: 'members.csv', content: MEMBERS_CSV, encoding: 'utf8' };
const column = (label: string, type: string, samples: string[]) => ({
  pointer: `/${label}`,
  label,
  type,
  samples,
  blanks: 0,
  duplicates: 0,
});
const draft = {
  id: IDS.file,
  orgId: IDS.org,
  state: 'draft',
  name: 'members.csv',
  format: 'csv',
  sheets: [],
  sheet: null,
  recordsPointer: null,
  bytes: MEMBERS_CSV.length,
  rows: 5,
  columns: [
    column('Holder email', 'email', ['ada@example.com', 'grace@example.com']),
    column('Name', 'text', ['Ada Example', 'Grace Okafor']),
    column('Member ID', 'text', ['NW-1001', 'NW-1002']),
  ],
  preview: {
    header: ['Holder email', 'Name', 'Member ID'],
    rows: [
      ['ada@example.com', 'Ada Example', 'NW-1001'],
      ['grace@example.com', 'Grace Okafor', 'NW-1002'],
    ],
  },
  idCandidates: ['/Member ID', '/Holder email', '/Name'],
  createdAt: T.now,
  expiresAt: T.now + 23 * HOUR,
};
const revision = {
  id: IDS.revision,
  connectionId: IDS.connection,
  revision: 2,
  state: 'pending',
  name: 'members.csv',
  format: 'csv',
  sheet: null,
  bytes: MEMBERS_CSV.length + 40,
  rows: 6,
  skipped: { noId: 0, duplicate: 0 },
  diff: {
    added: 1,
    changed: 1,
    removed: 0,
    examples: { added: ['NW-1006'], changed: ['NW-1001'], removed: [] },
  },
  applied: false,
  createdBy: IDS.user,
  createdByName: 'Mei Tanaka',
  createdAt: T.now,
  expiresAt: T.now + 23 * HOUR,
  supersededAt: null,
};

/** `<operationId> <request|response>` to its example. */
export const CONNECTION_FILE_EXAMPLES: Record<string, unknown> = {
  'connections.postConnectionsUploads request': upload,
  'connections.postConnectionsUploads response': draft,
  'connections.getConnectionsUploadsByFileId response': draft,
  'connections.patchConnectionsUploadsByFileId request': { sheet: 'Members' },
  'connections.patchConnectionsUploadsByFileId response': draft,
  'connections.postConnectionsByIdFiles request': upload,
  'connections.postConnectionsByIdFiles response': { unchanged: false, ...revision },
  'connections.getConnectionsByIdFiles response': { items: [revision], nextCursor: null },
  'connections.postConnectionsByIdFilesByFileIdApply response': {
    file: { ...revision, state: 'current', expiresAt: null },
    runId: IDS.run,
    workflowInstanceId: '0193a1b2-7c00-7000-8000-77d7e7d2234c',
  },
};
