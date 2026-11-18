import { PASS_IMPORT_MAX_BYTES } from '../../../shared/contracts/pass-imports.ts';
import { CsvError, type ParsedCsv, parseCsv } from '../../../shared/csv/parse.ts';
import { UpstreamError, ValidationError } from '../../platform/errors.ts';
import { createSafeFetch, type DnsResolver, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export type ImportSource =
  | { kind: 'file'; name: string; csv: string }
  | { kind: 'url'; url: string };

const MAX_HEADER = 200;
/** A published Google sheet answers with a redirect to its export host. */
const SHEET_REDIRECTS = 3;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Test seam: DNS and fetch for the sheet link. Production leaves both unset (real DNS-over-HTTPS and `fetch`). */
export const importFetchSeam: { resolver?: DnsResolver; fetchImpl?: typeof fetch } = {};

export const objectKeyOf = (orgId: string, id: string): string =>
  `uploads/pass-imports/${orgId}/${id}.csv`;

/** The file bytes: the uploaded text, or one fetch of the sheet link. Up to three redirect hops, each checked by safe-fetch. */
export async function sourceBytes(ctx: ServiceContext, source: ImportSource): Promise<Uint8Array> {
  if (source.kind === 'file') return new TextEncoder().encode(source.csv);
  const fetchSafe = createSafeFetch({
    platformHosts: platformHostsOf(ctx.env),
    maxBytes: PASS_IMPORT_MAX_BYTES,
    maxRedirects: SHEET_REDIRECTS,
    ...(importFetchSeam.resolver ? { resolver: importFetchSeam.resolver } : {}),
    ...(importFetchSeam.fetchImpl ? { fetchImpl: importFetchSeam.fetchImpl } : {}),
  });
  const response = await fetchSafe(source.url, { headers: { accept: 'text/csv, text/plain' } });
  if (response.status !== 200)
    throw new UpstreamError('The sheet link did not return the file. Check the link.');
  return response.body;
}

/** Only the host of a link is kept: a publish-to-web link is a secret. */
export const sourceName = (source: ImportSource): string =>
  source.kind === 'file' ? source.name : new URL(source.url).host;

export function parseImport(bytes: Uint8Array): ParsedCsv {
  try {
    const parsed = parseCsv(bytes);
    if (parsed.header.some((h) => h.length > MAX_HEADER))
      throw new ValidationError(
        `A column header is longer than ${MAX_HEADER} characters.`,
        [],
        'IMPORT_HEADER_TOO_LONG',
      );
    return parsed;
  } catch (error) {
    if (error instanceof CsvError) throw new ValidationError(error.message, [], error.code);
    throw error;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
