// What a row prints beyond the bench time: the duration and the path cut in the middle.
/** `24 ms`, `2.4 s`, `12 s`. */
export const duration = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** A call this slow is marked. */
export const SLOW_MS = 1000;

/** A run of the shown path; `id` runs are dimmed so the resource names lead. */
export interface PathRun {
  text: string;
  id: boolean;
}

const ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{15,})$/i;
/** The tail that always shows (the last segment and the query) is at most this long, or the path just ends in `…`. */
const TAIL_MAX = 36;

function runs(text: string): PathRun[] {
  const out: PathRun[] = [];
  for (const piece of text.split(/(\/|\?|&|=)/)) {
    if (!piece) continue;
    const id = ID.test(piece);
    const last = out.at(-1);
    if (last && last.id === id) last.text += piece;
    else out.push({ text: piece, id });
  }
  return out;
}

function splitAt(all: PathRun[], at: number): [PathRun[], PathRun[]] {
  const head: PathRun[] = [];
  const tail: PathRun[] = [];
  let seen = 0;
  for (const run of all) {
    const end = seen + run.text.length;
    if (end <= at) head.push(run);
    else if (seen >= at) tail.push(run);
    else {
      head.push({ text: run.text.slice(0, at - seen), id: run.id });
      tail.push({ text: run.text.slice(at - seen), id: run.id });
    }
    seen = end;
  }
  return [head, tail];
}

/**
 * The path as a row shows it: without `/api/v1`, with its query, split for truncation in the middle. The head
 * shrinks to an ellipsis; the tail (the last segment and the query) always shows when it is short enough.
 */
export function pathParts(
  path: string,
  query: string | null,
): { full: string; head: PathRun[]; tail: PathRun[] } {
  const bare = path.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  const q = query ? `?${query}` : '';
  const full = bare + q;
  const lastSlash = bare.lastIndexOf('/');
  let cut = lastSlash > 0 ? lastSlash : full.length;
  if (full.length - cut > TAIL_MAX) cut = q && q.length <= TAIL_MAX ? bare.length : full.length;
  const [head, tail] = splitAt(runs(full), cut);
  return { full, head, tail };
}
