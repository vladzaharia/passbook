import { classify, routeMatches } from '../../../shared/developers-search.ts';
import type {
  ActionDoc,
  ErrorDoc,
  EventDoc,
  GuideDoc,
  HintDoc,
  OpDoc,
  SearchIndex,
} from './types.ts';

export interface Results {
  errors: ErrorDoc[];
  ops: OpDoc[];
  guides: GuideDoc[];
  events: EventDoc[];
  actions: ActionDoc[];
}

/** Rows shown per group. */
export const LIMITS = { errors: 5, ops: 6, guides: 4, events: 3, actions: 3 } as const;

/** What a query is made of: lower case words, `/api/v1` and the SDK's `pb.` dropped. */
export function wordsOf(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/\/api\/v1(?=\/|\s|$)/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/^pb\./, ''))
    .filter(Boolean);
}

/**
 * How well one word matches a field, lower is better: the whole field, its start, the start of a
 * word inside it (after `_`, `.`, `/`, a space), anywhere. Null when it does not appear.
 */
function tier(field: string, word: string): number | null {
  if (field === word) return 0;
  if (field.startsWith(word)) return 1;
  const at = field.indexOf(word);
  if (at < 0) return null;
  return /[a-z0-9]/.test(field[at - 1] ?? ' ') ? 3 : 2;
}

/** Fields that name the thing count in full; words found only in its prose count four tiers worse. */
const PROSE = 4;

/**
 * The score of one record: the sum, over the query's words, of each word's best match, plus a
 * fraction for the length of its name. Every word must match somewhere. Pure in (record, words): nothing that arrives later can change it.
 */
function score(primary: readonly string[], prose: readonly string[], words: readonly string[]) {
  // Tiers decide; among equals the shorter name is the closer match ("List releases" before
  // "List release-backed templates available to an organization").
  let total = Math.min((primary[0] ?? '').length, 999) / 1000;
  for (const word of words) {
    let best: number | null = null;
    for (const field of primary) {
      const t = tier(field.toLowerCase(), word);
      if (t !== null && (best === null || t < best)) best = t;
    }
    for (const field of prose) {
      const t = tier(field.toLowerCase(), word);
      if (t !== null && (best === null || t + PROSE < best)) best = t + PROSE;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * The best `limit` records by score. Ties keep the index's own order (the order the build wrote:
 * reference order, then code order), so the same query always gives the same list.
 */
function top<T>(docs: readonly T[], limit: number, scoreOf: (doc: T) => number | null): T[] {
  const scored: { doc: T; at: number; score: number }[] = [];
  docs.forEach((doc, at) => {
    const s = scoreOf(doc);
    if (s !== null) scored.push({ doc, at, score: s });
  });
  scored.sort((a, b) => a.score - b.score || a.at - b.at);
  return scored.slice(0, limit).map((s) => s.doc);
}

const NONE: Results = { errors: [], ops: [], guides: [], events: [], actions: [] };

/** What to offer before anything is typed. */
export function suggestions(index: SearchIndex): Results {
  return {
    ...NONE,
    guides: index.guides.filter((g) => g.kind === 'guide').slice(0, LIMITS.guides),
    actions: index.actions.slice(0, LIMITS.actions),
  };
}

/** How each kind of record is scored for a query: its name fields, then its prose. */
function scorers(query: string) {
  const words = wordsOf(query);
  const pasted = classify(query);
  const route = pasted.kind === 'route' ? pasted : null;
  return {
    words,
    error: (e: ErrorDoc) => score([e.code, e.title], [e.when, e.fix], words),
    op: (o: OpDoc) =>
      route && (!route.method || route.method === o.method) && routeMatches(o.path, route.path)
        ? -1
        : score([o.title, o.sdk, o.id, o.path, o.method], [o.desc], words),
    guide: (g: GuideDoc) => score([g.title], [g.line], words),
    event: (e: EventDoc) => score([e.type], [e.summary], words),
    action: (a: ActionDoc) => score([a.label], [a.words, a.line], words),
  };
}

/** The best rows per group for `query`, ranked. A pure function of the index and the query. */
export function search(index: SearchIndex, query: string): Results {
  const by = scorers(query);
  if (by.words.length === 0) return suggestions(index);
  return {
    errors: top(index.errors, LIMITS.errors, by.error),
    ops: top(index.ops, LIMITS.ops, by.op),
    guides: top(index.guides, LIMITS.guides, by.guide),
    events: top(index.events, LIMITS.events, by.event),
    actions: top(index.actions, LIMITS.actions, by.action),
  };
}

/**
 * `shown` cut down to the rows that still match a longer `query`, in the order they were in. This
 * is what the list does while keys are still going in: it only loses rows, never reorders them.
 */
export function narrow(shown: Results, query: string): Results {
  const by = scorers(query);
  const keep = <T>(rows: T[], scoreOf: (row: T) => number | null) =>
    rows.filter((row) => scoreOf(row) !== null);
  return {
    errors: keep(shown.errors, by.error),
    ops: keep(shown.ops, by.op),
    guides: keep(shown.guides, by.guide),
    events: keep(shown.events, by.event),
    actions: keep(shown.actions, by.action),
  };
}

export const isEmpty = (r: Results): boolean =>
  r.errors.length + r.ops.length + r.guides.length + r.events.length + r.actions.length === 0;

/** The answer for a word that finds nothing, when the index has one. */
export function hintFor(index: SearchIndex, query: string): HintDoc | null {
  const words = wordsOf(query);
  return index.hints.find((h) => h.terms.some((t) => words.includes(t))) ?? null;
}

export interface Piece {
  text: string;
  hit: boolean;
}

/** `label` cut at the query's words, so the matched parts can be marked. */
export function pieces(label: string, words: readonly string[]): Piece[] {
  const lower = label.toLowerCase();
  const marked = new Array<boolean>(label.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length))
      marked.fill(true, at, at + word.length);
  }
  const out: Piece[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = marked[i] === true;
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += label[i];
    else out.push({ text: label[i] ?? '', hit });
  }
  return out;
}
