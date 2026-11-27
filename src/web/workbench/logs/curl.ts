import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import { type CopyLang, copyAs } from '../console/copy-as.ts';
import type { Json } from '../console/types.ts';

/** Stored request headers worth sending again. Left out: the length (the client's to compute), a body's type (added with the body), and Idempotency-Key and If-Match, which would replay the cached answer or fail with 412. */
const SKIP = new Set(['content-length', 'idempotency-key', 'if-match']);
const sentHeaders = (row: RequestLogDetail, hasBody: boolean): [string, string][] =>
  Object.entries(row.headers?.req ?? {}).filter(
    ([name]) => !SKIP.has(name) && !(hasBody && name === 'content-type'),
  );

/** The logged call in a language, with the key read from `$PASSBOOK_KEY`; a body that is not JSON is left out. */
export function codeOf(lang: CopyLang, row: RequestLogDetail, origin: string): string {
  let body: Json | undefined;
  try {
    body = row.requestBody ? (JSON.parse(row.requestBody) as Json) : undefined;
  } catch {
    // A marker (`[binary body]`, too large) is not a body to send again.
    body = undefined;
  }
  const url = `${origin}${row.path}${row.query ? `?${row.query}` : ''}`;
  return copyAs(lang, {
    method: row.method,
    url,
    headers: sentHeaders(row, body !== undefined),
    body,
  });
}
