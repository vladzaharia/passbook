import { redirect } from '@tanstack/react-router';
import { type WbTool, wbHref } from '@/shared/workbench.ts';
import { writePrefill } from './prefill.ts';

/** The Quickstart hashes of the old docs page: the sandbox's own area now. */
const SANDBOX_HASHES: ReadonlySet<string> = new Set(['sandbox', 'start-over', 'delete-sandbox']);

/**
 * Where an old docs link really goes, or null. `/developers/console#<op>?body=<json>&q.<name>=<v>`
 * becomes `?op=<op>&prefill=<nonce>` with the body kept in `sessionStorage`, never in the URL
 * (design §4.2, L19); the old Quickstart's sandbox hashes become the Sandbox area. Any other hash
 * is a selection and stays.
 */
export function legacyHref(
  tool: WbTool,
  hash: string,
  nonce: () => string = () => crypto.randomUUID(),
): string | null {
  if (tool === 'quickstart' && SANDBOX_HASHES.has(hash)) return wbHref('sandbox', { hash });
  const at = hash.indexOf('?');
  if (tool !== 'console' || at < 0) return null;
  let op = '';
  try {
    op = decodeURIComponent(hash.slice(0, at));
  } catch {
    // A malformed escape names no operation.
    return null;
  }
  if (!op) return null;
  const query: Record<string, string> = {};
  let body: unknown;
  for (const [k, v] of new URLSearchParams(hash.slice(at + 1))) {
    if (k === 'body') {
      try {
        body = JSON.parse(v);
      } catch {
        // A body that is not JSON is dropped; the operation opens on its own sample.
      }
    } else if (k.startsWith('q.')) query[k.slice(2)] = v;
  }
  if (body === undefined && Object.keys(query).length === 0)
    return wbHref('console', { query: { op } });
  const id = writePrefill({ op, query, body }, nonce());
  if (!id) return wbHref('console', { query: { op } });
  return wbHref('console', { query: { op, prefill: id } });
}

/** Throws the redirect for an old docs link; a no-op for any other hash. */
export function redirectLegacy(tool: WbTool, tail: { searchStr: string; hash: string }): void {
  const href = legacyHref(tool, tail.hash);
  if (href) throw redirect({ href, replace: true });
}
