/** `fu1:<fileId>:<bases>:<phase>:<n>`: `rows` emits the current file page by page, `removed` the refs it lost. */
export type Phase = 'rows' | 'removed' | 'done';

/** Earlier revisions to diff against: none, the listed file ids, or every retained one. */
export type Bases = readonly string[] | 'all';

export interface Cursor {
  fileId: string;
  bases: Bases;
  phase: Phase;
  n: number;
}

/** Bases tracked across unfinished runs before the sync falls back to every retained revision. */
export const MAX_BASES = 3;

export const encode = (c: Cursor): string =>
  `fu1:${c.fileId}:${c.bases === 'all' ? 'all' : c.bases.length ? c.bases.join(',') : '-'}:${c.phase}:${c.n}`;

/** Null for no cursor or one that is not ours; the sync then starts over against every retained revision. */
export function decode(cursor: string | null): Cursor | null {
  const [tag, fileId, bases, phase, n, extra] = (cursor ?? '').split(':');
  if (tag !== 'fu1' || !fileId || !bases || extra !== undefined) return null;
  const at = Number(n);
  if (phase !== 'rows' && phase !== 'removed' && phase !== 'done') return null;
  if (!Number.isSafeInteger(at) || at < 0) return null;
  return {
    fileId,
    bases: bases === 'all' ? 'all' : bases === '-' ? [] : bases.split(','),
    phase,
    n: at,
  };
}

/** The bases for a run over a new file, given where the previous run stopped. */
export function basesFor(previous: Cursor | null): Bases {
  if (!previous) return 'all';
  if (previous.bases === 'all') return 'all';
  const union =
    previous.phase === 'done' ? [previous.fileId] : [...previous.bases, previous.fileId];
  return union.length > MAX_BASES ? 'all' : union;
}
