import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import { type CopyLang, copyAs } from '../console/copy-as.ts';
import type { Json } from '../console/types.ts';

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
  return copyAs(lang, { method: row.method, url, headers: [], body });
}
