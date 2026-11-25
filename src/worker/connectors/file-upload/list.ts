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
  changes: { ref: string; record?: UpstreamRecord; deleted?: boolean }[];
  cursor: string;
  hasMore: boolean;
}

/** Refs in an earlier revision that the current one lacks, sorted. Bases swept since are skipped. */
async function removedRefs(
  files: ConnectionFilesPort,
  current: ConnectorFile,
  bases: Bases,
): Promise<string[]> {
  const retained = await files.previous(RETAINED);
  const wanted = bases === 'all' ? retained : retained.filter((f) => bases.includes(f.id));
  if (wanted.length === 0) return [];
  const now = new Set((await files.refs(current.id)).map((r) => r.ref));
  const gone = new Set<string>();
  for (const file of wanted)
    for (const { ref } of await files.refs(file.id)) if (!now.has(ref)) gone.add(ref);
  return [...gone].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const start = (fileId: string, bases: Bases): Cursor => ({ fileId, bases, phase: 'rows', n: 0 });

/**
 * Every row of the current revision, then the refs it lost. The core decides unchanged versus update, so a
 * mapping change re-applies cleanly; a finished file lists nothing.
 */
export async function list(files: ConnectionFilesPort, cursor: string | null): Promise<Listing> {
  const current = await files.current();
  if (!current) throw new ConnectorError('CONFIG', { permanent: true });
  const previous = decode(cursor);
  let at: Cursor;
  if (previous?.fileId === current.id) {
    if (previous.phase === 'done') return { changes: [], cursor: encode(previous), hasMore: false };
    at = previous;
  } else {
    at = start(current.id, basesFor(previous));
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

  const gone = await removedRefs(files, current, at.bases);
  const slice = gone.slice(at.n * REMOVED_PAGE, (at.n + 1) * REMOVED_PAGE);
  const more = (at.n + 1) * REMOVED_PAGE < gone.length;
  return {
    changes: slice.map((ref) => ({ ref, deleted: true })),
    cursor: encode(more ? { ...at, n: at.n + 1 } : { ...at, bases: [], phase: 'done', n: 0 }),
    hasMore: more,
  };
}
