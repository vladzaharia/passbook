const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** `14:02:11` today, `Nov 19 14:02` before; the browser's local time. */
export function clock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(ms, now)) return `${time}:${two(d.getSeconds())}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** True when `clock` shows a date: the time column widens for it. */
export const notToday = (ms: number, now = Date.now()): boolean => !sameDay(ms, now);

/** `Nov 19, 2026, 14:02:11`: the row's title and the detail. */
export function fullTime(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** `1,234`. */
export const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The pill tone of a status: 2xx success, 3xx info, 4xx warning, 5xx danger. */
export const flavour = (status: number): 'success' | 'info' | 'warning' | 'danger' =>
  status >= 500 ? 'danger' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';

/** A stored body for display: JSON indented, a marker as it is, nothing as null. */
export function prettyBody(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** `24 ms`, `2.4 s`, `12 s`. */
export const duration = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** A call this slow is marked. */
export const SLOW_MS = 1000;

/** The duration bar's fill, 0 to 1, on a log scale that is full at 3 s: 10 ms and 100 ms still read apart. */
export const durationShare = (ms: number): number =>
  Math.min(1, Math.log10(Math.max(0, ms) + 1) / Math.log10(3001));

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
