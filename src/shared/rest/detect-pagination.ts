import type { RestPagination } from '../contracts/connection-probe.ts';
import { escapeToken } from '../records/fields.ts';
import { linkRels } from './link-header.ts';

export interface PaginationInput {
  /** The request URL: its query tells which paging parameters the caller already sends. */
  url: string;
  body: unknown;
  /** Response headers by lower-case name. */
  headers: Readonly<Record<string, string>>;
  /** Where the records array sits, if any; its subtree is not searched. */
  recordsPointer: string | null;
  /** Records on this page. */
  count: number;
  /** Records carry a usable ID. */
  hasIds: boolean;
}

export interface PaginationCandidate {
  confidence: 'high' | 'medium' | 'low';
  config: RestPagination;
  /** A code for what gave it away: `header:link`, `field:/meta/next_cursor`, `query:page`. */
  evidence: string;
}

interface Leaf {
  pointer: string;
  key: string;
  parent: string;
  value: string | number | boolean | null;
}

const MAX_NODES = 2000;
const MAX_DEPTH = 4;
const MAX_CANDIDATES = 3;
const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Scalars of the body's objects down to a few levels; arrays (records and their kin) are not entered. */
function leavesOf(body: unknown, skip: string | null): Leaf[] {
  const out: Leaf[] = [];
  let nodes = 0;
  const walk = (value: unknown, pointer: string, key: string, parent: string, depth: number) => {
    if (++nodes > MAX_NODES || pointer === skip || Array.isArray(value)) return;
    if (typeof value === 'object' && value !== null) {
      if (depth >= MAX_DEPTH) return;
      for (const k in value) {
        if (!Object.hasOwn(value, k)) continue;
        walk(
          (value as Record<string, unknown>)[k],
          `${pointer}/${escapeToken(k)}`,
          k,
          key,
          depth + 1,
        );
      }
      return;
    }
    if (pointer === '') return;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      out.push({ pointer, key, parent, value: value as Leaf['value'] });
  };
  walk(body, '', '', '', 0);
  return out.sort((a, b) => a.pointer.split('/').length - b.pointer.split('/').length);
}

const first = (leaves: Leaf[], re: RegExp, type: 'string' | 'number' | 'boolean') =>
  leaves.find((l) => re.test(l.key) && typeof l.value === type);
const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

const URLISH = /^(https?:\/\/|\/)/i;
const NEXT_URL_KEY = /^(next_?url|next_?page_?url|next_?link|@odata\.nextlink)$/i;
const CURSOR_KEY =
  /^(next_?cursor|cursor|after|end_?cursor|next_?page_?token|next_?token|continuation(_?token)?|offset)$/i;
const HAS_MORE = /^(has_?more|has_?next(_?page)?|more)$/i;
const PAGE_KEY = /^(page|current_?page|page_?number|page_?no|page_?index)$/i;
const TOTAL_PAGES = /^(total_?pages|last_?page|page_?count|num_?pages|pages)$/i;
const SIZE_KEY = /^(per_?page|page_?size|limit|size|take|count)$/i;
const OFFSET_KEY = /^(offset|skip|start)$/i;
const TOTAL_KEY = /^(total|total_?count|total_?results|total_?items|total_?records|hits)$/i;
const QUERY_PAGE = /^(page|page_?number|page_?no|page_?index|p)$/i;
const QUERY_SIZE = /^(per_?page|page_?size|limit|size|take|count)$/i;
const TOTAL_PAGES_HEADERS: Record<string, string> = {
  'x-wp-totalpages': 'X-WP-TotalPages',
  'x-total-pages': 'X-Total-Pages',
  'x-total-page-count': 'X-Total-Page-Count',
};

/** The query parameter a cursor token is sent in, from the response key that carries it. */
function cursorParam(key: string): string {
  if (/^next_?cursor$/i.test(key)) return 'cursor';
  if (/^(after|end_?cursor)$/i.test(key)) return 'after';
  if (/^next_?page_?token$/i.test(key)) return key.includes('_') ? 'page_token' : 'pageToken';
  return key;
}

const nextLinks = (leaves: Leaf[]): PaginationCandidate[] =>
  leaves
    .filter(
      (l) =>
        NEXT_URL_KEY.test(l.key) ||
        (/^(link|href|url)$/i.test(l.key) && /^next$/i.test(l.parent)) ||
        (/^next$/i.test(l.key) && typeof l.value === 'string' && URLISH.test(l.value)),
    )
    .filter((l) => l.value === null || (typeof l.value === 'string' && URLISH.test(l.value)))
    .map(
      (l): PaginationCandidate => ({
        confidence: l.value === null ? 'medium' : 'high',
        config: { style: 'next-link', nextPointer: l.pointer },
        evidence: `field:${l.pointer}`,
      }),
    );

function cursors(leaves: Leaf[], input: PaginationInput): PaginationCandidate[] {
  const out: PaginationCandidate[] = [];
  for (const l of leaves) {
    if (!CURSOR_KEY.test(l.key) || (l.value !== null && typeof l.value !== 'string')) continue;
    const flag = leaves.find(
      (f) => HAS_MORE.test(f.key) && typeof f.value === 'boolean' && f.parent === l.parent,
    );
    out.push({
      confidence: l.value === null ? 'medium' : 'high',
      config: {
        style: 'cursor',
        param: cursorParam(l.key),
        cursorPointer: l.pointer,
        ...(flag ? { hasMorePointer: flag.pointer } : {}),
        from: 'body',
      },
      evidence: `field:${l.pointer}`,
    });
  }
  const more = first(leaves, HAS_MORE, 'boolean');
  if (out.length === 0 && more && input.hasIds) {
    // Stripe: `object: "list"`, `has_more`, and the last record's ID goes back as `starting_after`.
    const stripe = first(leaves, /^object$/i, 'string')?.value === 'list';
    out.push({
      confidence: stripe ? 'high' : 'low',
      config: {
        style: 'cursor',
        param: stripe ? 'starting_after' : 'after',
        cursorPointer: '',
        hasMorePointer: more.pointer,
        from: 'last-id',
      },
      evidence: `field:${more.pointer}`,
    });
  }
  return out;
}

function pages(
  leaves: Leaf[],
  input: PaginationInput,
  query: URLSearchParams,
): PaginationCandidate[] {
  const header = Object.keys(TOTAL_PAGES_HEADERS).find((h) => /^\d+$/.test(input.headers[h] ?? ''));
  const total = first(leaves, TOTAL_PAGES, 'number');
  const current = first(leaves, PAGE_KEY, 'number');
  const asked = [...query.keys()].find((k) => QUERY_PAGE.test(k));
  if (!header && !total && !current && !asked) return [];
  const sizeKey = first(leaves, SIZE_KEY, 'number');
  const askedSize = [...query.keys()].find((k) => QUERY_SIZE.test(k));
  const size = intIn(askedSize ? Number(query.get(askedSize)) : sizeKey?.value, 1, 1000);
  const sizeParam = askedSize ?? sizeKey?.key;
  const start = current?.value === 0 || (asked && query.get(asked) === '0') ? 0 : 1;
  const evidence = header
    ? `header:${header}`
    : total
      ? `field:${total.pointer}`
      : current
        ? `field:${current.pointer}`
        : `query:${asked}`;
  const known = Boolean(header || total) && Boolean(header || current || asked);
  return [
    {
      confidence: header || known ? 'high' : 'medium',
      config: {
        style: 'page',
        param: asked ?? 'page',
        start,
        ...(sizeParam && size ? { sizeParam, size } : {}),
        ...(total && !header ? { totalPagesPointer: total.pointer } : {}),
        ...(header && TOTAL_PAGES_HEADERS[header]
          ? { totalPagesHeader: TOTAL_PAGES_HEADERS[header] }
          : {}),
      },
      evidence,
    },
  ];
}

function offsets(
  leaves: Leaf[],
  input: PaginationInput,
  query: URLSearchParams,
  paged: boolean,
): PaginationCandidate[] {
  const off = first(leaves, OFFSET_KEY, 'number');
  const asked = [...query.keys()].find((k) => OFFSET_KEY.test(k));
  const limit = first(leaves, SIZE_KEY, 'number');
  const total = first(leaves, TOTAL_KEY, 'number');
  const hasOffset = Boolean(off || asked);
  if (!hasOffset && !(total && limit && !paged)) return [];
  const askedSize = [...query.keys()].find((k) => QUERY_SIZE.test(k));
  const size =
    intIn(askedSize ? Number(query.get(askedSize)) : limit?.value, 1, 1000) ??
    intIn(input.count, 1, 1000);
  if (!size) return [];
  return [
    {
      confidence: hasOffset && total && (limit || askedSize) ? 'high' : 'medium',
      config: {
        style: 'offset',
        param: asked ?? off?.key ?? 'offset',
        sizeParam: askedSize ?? limit?.key ?? 'limit',
        size,
        ...(total ? { totalPointer: total.pointer } : {}),
      },
      evidence: asked ? `query:${asked}` : `field:${(off ?? total)?.pointer}`,
    },
  ];
}

const pointersOf = (c: RestPagination): string[] =>
  [
    'nextPointer' in c ? c.nextPointer : undefined,
    'cursorPointer' in c ? c.cursorPointer : undefined,
    'hasMorePointer' in c ? c.hasMorePointer : undefined,
    'totalPagesPointer' in c ? c.totalPagesPointer : undefined,
    'totalPointer' in c ? c.totalPointer : undefined,
  ].filter((p): p is string => p !== undefined);

/**
 * How a response says where the next page is, best first (at most 3), in the order a sync would try:
 * Link header, next URL field, cursor field, page fields, offset fields. Nothing found is `none`.
 */
export function detectPagination(input: PaginationInput): PaginationCandidate[] {
  const leaves = leavesOf(input.body, input.recordsPointer);
  const query = URL.canParse(input.url) ? new URL(input.url).searchParams : new URLSearchParams();
  const found: PaginationCandidate[] = [];
  const rels = linkRels(input.headers.link ?? null);
  if (Object.keys(rels).length > 0)
    found.push({
      confidence: rels.next ? 'high' : 'medium',
      config: { style: 'link-header' },
      evidence: 'header:link',
    });
  found.push(...nextLinks(leaves), ...cursors(leaves, input));
  const paged = pages(leaves, input, query);
  found.push(...paged, ...offsets(leaves, input, query, paged.length > 0));
  if (found.length === 0)
    return [{ confidence: 'low', config: { style: 'none' }, evidence: 'none' }];
  // Array.sort is stable: equal confidence keeps the priority order above.
  return found
    .filter((c) => pointersOf(c.config).every((p) => p.length <= 500))
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence])
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ ...c, evidence: c.evidence.slice(0, 200) }));
}
