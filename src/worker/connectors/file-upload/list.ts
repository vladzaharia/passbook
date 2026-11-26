import {
  type ConnectionFilesPort,
  ConnectorError,
  type ConnectorFile,
  type UpstreamRecord,
} from '../types.ts';
import { type Bases, basesFor, type Cursor, decode, encode } from './cursor.ts';

const REMOVED_PAGE = 200;
/** Superseded revisions the platform keeps are far fewer; this only bounds the read. */
const RETAINED = 10;

export interface Listing {
  /** A removal carries no record and no `deleted` flag: the core asks `fetchRecord` at apply time. */
  changes: { ref: string; record?: UpstreamRecord }[];
  cursor: string;
  hasMore: boolean;
}

type Log = (event: string, data?: Record<string, string | number>) => void;

/**
 * Refs the current revision lacks that an earlier one had, sorted. Diffs against every retained revision
 * newer than the oldest base (revisions no run has seen included); a base that retention swept means every
 * retained one. A reset therefore also applies today's `onMissing` to rows removed under an earlier policy.
 */
async function removedRefs(
  files: ConnectionFilesPort,
  current: ConnectorFile,
  bases: Bases,
  log: Log,
): Promise<string[]> {
  const retained = await files.previous(RETAINED);
  let wanted = retained;
  if (bases !== 'all') {
    const at = bases.map((id) => retained.findIndex((f) => f.id === id));
    if (at.length > 0 && !at.includes(-1)) wanted = retained.slice(0, Math.max(...at) + 1);
  }
  if (wanted.length === 0) return [];
  const now = new Set((await files.refs(current.id)).map((r) => r.ref));
  const gone = new Set<string>();
  for (const file of wanted) {
    let refs: Awaited<ReturnType<ConnectionFilesPort['refs']>>;
    try {
      refs = await files.refs(file.id);
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      // Unreadable objects count as swept: the other revisions still give removals.
      log('file_base_unreadable', { code: 'FILE_BASE_UNREADABLE' });
      continue;
    }
    for (const { ref } of refs) if (!now.has(ref)) gone.add(ref);
  }
  return [...gone].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every row of the current revision, then the refs it lost. The core decides unchanged versus update, so a
 * mapping change re-applies cleanly; a finished file lists nothing.
 */
export async function list(
  files: ConnectionFilesPort,
  cursor: string | null,
  log: Log,
): Promise<Listing> {
  const current = await files.current();
  if (!current) throw new ConnectorError('CONFIG', { permanent: true });
  const previous = decode(cursor);
  let at: Cursor;
  if (previous?.fileId === current.id) {
    if (previous.phase === 'done') return { changes: [], cursor: encode(previous), hasMore: false };
    at = previous;
  } else {
    at = { fileId: current.id, bases: basesFor(previous), phase: 'rows', n: 0, after: '' };
  }

  if (at.phase === 'rows') {
    const page = at.n < current.pages ? await files.page(current.id, at.n) : [];
    const next = at.n + 1;
    const last = next >= current.pages;
    return {
      changes: page.map(({ ref, record }) => ({ ref, record })),
      cursor: encode(last ? { ...at, phase: 'removed', n: 0 } : { ...at, n: next }),
      hasMore: true,
    };
  }

  const gone = (await removedRefs(files, current, at.bases, log)).filter((ref) => ref > at.after);
  const slice = gone.slice(0, REMOVED_PAGE);
  const last = slice.at(-1);
  if (gone.length > slice.length && last !== undefined)
    return {
      changes: slice.map((ref) => ({ ref })),
      cursor: encode({ ...at, after: last }),
      hasMore: true,
    };
  const done = encode({ ...at, bases: [], phase: 'done', n: 0 });
  // A revision applied while this run was listing is not ours yet: go round again for it.
  const latest = await files.current();
  return {
    changes: slice.map((ref) => ({ ref })),
    cursor: done,
    hasMore: latest?.id !== current.id,
  };
}
