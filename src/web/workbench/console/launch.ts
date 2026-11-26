import { readPrefill, writePrefill } from '../host/prefill.ts';
import { type Prefill, parseHash } from './prefill.ts';
import type { RunOp } from './types.ts';

/** Where a Console link came from: `?op=` alone, a guide's sample, a Logs row, or another tool's handoff. */
export interface Launch {
  op: string | null;
  sample: string | null;
  from: string | null;
  prefill: string | null;
}

export function launchOf(search: string): Launch {
  const q = new URLSearchParams(search);
  const pick = (k: string) => q.get(k) || null;
  return { op: pick('op'), sample: pick('sample'), from: pick('from'), prefill: pick('prefill') };
}

export type Source = 'reference' | 'guide' | 'log' | 'handoff';

/** What fills the form, before any body from the network (a Logs row) arrives. */
export interface Filled {
  source: Source;
  prefill: Prefill;
  /** A line over the form saying where the request came from, or why it is the sample. */
  note: string | null;
}

/** The request body of a Logs row, as it was logged: JSON text, else nothing to fill in. */
export function bodyOfLog(text: string | null | undefined): Prefill['body'] {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Prefill['body'];
  } catch {
    return undefined;
  }
}

/**
 * The synchronous sources. The operation's own sample is the form's start, so `reference` has no
 * prefill; a guide's snippet names its body and query; a handoff nonce is read once. A Logs row
 * (`from`) arrives through `fromLog` once its detail has been read.
 */
export function fillFor(op: RunOp, launch: Launch): Filled {
  if (launch.prefill) {
    const h = readPrefill(launch.prefill);
    if (h && h.op === op.id)
      return {
        source: 'handoff',
        prefill: {
          query: h.query ?? {},
          ...(h.path ? { path: h.path } : {}),
          literal: true,
          ...(h.body !== undefined ? { body: h.body } : {}),
        },
        note: null,
      };
  }
  const snippet = launch.sample ? op.samples?.[launch.sample] : undefined;
  if (snippet)
    return {
      source: 'guide',
      prefill: {
        query: snippet.query ?? {},
        ...(snippet.body !== undefined ? { body: snippet.body } : {}),
      },
      note: null,
    };
  return { source: launch.from ? 'log' : 'reference', prefill: { query: {} }, note: null };
}

/**
 * An old link, `#<operationId>?body=…` (a guide's, from before the Console took `?op=`): the body moves
 * into session storage under a nonce and the address becomes `?op=&prefill=<nonce>`. Returns the search to use, or null.
 */
export function shimHash(hash: string, search: string): string | null {
  if (!hash.includes('?')) return null;
  const { id, prefill } = parseHash(hash);
  if (!id) return null;
  const q = new URLSearchParams(search);
  q.set('op', id);
  q.set(
    'prefill',
    writePrefill({
      op: id,
      query: prefill.query,
      ...(prefill.body !== undefined ? { body: prefill.body } : {}),
    }),
  );
  return `?${q}`;
}

/** The operation whose path template matches a logged call, with the ids it carried. */
export function matchOp(
  ops: readonly { id: string; method: string; path: string }[],
  method: string,
  path: string,
): { id: string; ids: Record<string, string> } | null {
  const bare = path.replace(/\/+$/, '');
  for (const op of ops) {
    if (op.method.toLowerCase() !== method.toLowerCase()) continue;
    const names: string[] = [];
    const rx = new RegExp(
      `^${op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n: string) => {
        names.push(n);
        return '([^/]+)';
      })}$`,
    );
    const m = rx.exec(bare);
    if (m)
      return {
        id: op.id,
        ids: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')])),
      };
  }
  return null;
}
