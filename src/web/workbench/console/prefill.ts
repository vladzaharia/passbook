import { type Draft, parseBody, swapTemplate } from './request.ts';
import type { Json, RunOp } from './types.ts';

/** What a guide's "Open in console" link fills in: the body and the query. Path ids are the reader's own. */
export interface Prefill {
  body?: Json;
  query: Record<string, string>;
  /** Path ids, when the source knows them (a logged call): only parameters the operation declares are taken. */
  path?: Record<string, string>;
  /** The body is the reader's own (a handoff, a logged call): its ids stay, none is swapped for the template's. */
  literal?: true;
}

/** `#<operationId>?body=<json>&q.<name>=<value>` (built by guide/model.ts). A bad escape or body is dropped. */
export function parseHash(hash: string): { id: string; prefill: Prefill } {
  const raw = hash.replace(/^#/, '');
  const at = raw.indexOf('?');
  let id = '';
  try {
    id = decodeURIComponent(at < 0 ? raw : raw.slice(0, at));
  } catch {
    // A malformed escape in the hash: no operation, so the first one opens.
  }
  const prefill: Prefill = { query: {} };
  if (at >= 0)
    for (const [k, v] of new URLSearchParams(raw.slice(at + 1))) {
      const body = k === 'body' ? parseBody(v) : null;
      if (body?.ok && body.value !== undefined) prefill.body = body.value;
      else if (k.startsWith('q.')) prefill.query[k.slice(2)] = v;
    }
  return { id, prefill };
}

/** The draft with the prefill laid over it: only fields the operation declares. */
export function applyPrefill(
  draft: Draft,
  op: RunOp,
  prefill: Prefill,
  templateId: string | null,
): Draft {
  const query = Object.fromEntries(
    Object.entries(prefill.query).filter(([k]) =>
      op.params.some((p) => p.where === 'query' && p.name === k),
    ),
  );
  const path = Object.fromEntries(
    Object.entries(prefill.path ?? {}).filter(([k]) =>
      op.params.some((p) => p.where === 'path' && p.name === k),
    ),
  );
  return {
    ...draft,
    path: { ...draft.path, ...path },
    query: { ...draft.query, ...query },
    body:
      op.body && prefill.body !== undefined
        ? JSON.stringify(
            prefill.literal ? prefill.body : swapTemplate(prefill.body, templateId),
            null,
            2,
          )
        : draft.body,
  };
}
