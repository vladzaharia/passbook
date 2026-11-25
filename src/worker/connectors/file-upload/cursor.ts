/** `fu1:<fileId>:<bases>:<phase>:<n>`: `rows` emits the current file page by page, `removed` the refs it lost. */
export type Phase = 'rows' | 'removed' | 'done';

/** Earlier revisions to diff against: none, the listed file ids, or every retained one. */
export type Bases = readonly string[] | 'all';

export interface Cursor {
  fileId: string;
  bases: Bases;
  phase: Phase;
  /** Rows phase: the next page of the file. */
  n: number;
  /** Removed phase: the last ref emitted; the next page starts after it. Empty at the start. */
  after: string;
}

/** Bases tracked across unfinished runs before the sync falls back to every retained revision. */
export const MAX_BASES = 3;

const b64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const unb64 = (text: string): string | null => {
  try {
    const raw = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

export function encode(c: Cursor): string {
  const bases = c.bases === 'all' ? 'all' : c.bases.length ? c.bases.join(',') : '-';
  // A ref can hold any character, so it rides base64url behind an `r`; `-` is the start of the phase.
  const at = c.phase === 'removed' ? (c.after ? `r${b64(c.after)}` : '-') : String(c.n);
  return `fu1:${c.fileId}:${bases}:${c.phase}:${at}`;
}

/** Null for no cursor or one that is not ours; the sync then starts over against every retained revision. */
export function decode(cursor: string | null): Cursor | null {
  const [tag, fileId, bases, phase, at, extra] = (cursor ?? '').split(':');
  if (tag !== 'fu1' || !fileId || !bases || !at || extra !== undefined) return null;
  if (phase !== 'rows' && phase !== 'removed' && phase !== 'done') return null;
  const parsed = {
    fileId,
    bases: bases === 'all' ? ('all' as const) : bases === '-' ? [] : bases.split(','),
    phase: phase as Phase,
  };
  if (phase === 'removed') {
    if (at === '-') return { ...parsed, n: 0, after: '' };
    const after = at.startsWith('r') ? unb64(at.slice(1)) : null;
    return after ? { ...parsed, n: 0, after } : null;
  }
  const n = Number(at);
  return Number.isSafeInteger(n) && n >= 0 ? { ...parsed, n, after: '' } : null;
}

/** The bases for a run over a new file, given where the previous run stopped. */
export function basesFor(previous: Cursor | null): Bases {
  if (!previous) return 'all';
  if (previous.bases === 'all') return 'all';
  const union =
    previous.phase === 'done' ? [previous.fileId] : [...previous.bases, previous.fileId];
  return union.length > MAX_BASES ? 'all' : union;
}
