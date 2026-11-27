import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import { type CopyLang, copyAs } from '../console/copy-as.ts';
import type { Json } from '../console/types.ts';

/** The stored request headers worth sending again: the length is the client's to compute, and a body's type is added with the body. */
const sentHeaders = (row: RequestLogDetail, hasBody: boolean): [string, string][] =>
  Object.entries(row.headers?.req ?? {}).filter(
    ([name]) => name !== 'content-length' && !(hasBody && name === 'content-type'),
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
