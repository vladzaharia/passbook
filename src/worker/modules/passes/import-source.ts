import { PASS_IMPORT_MAX_BYTES } from '../../../shared/contracts/pass-imports.ts';
import { CsvError, type ParsedCsv, parseCsv } from '../../../shared/csv/parse.ts';
import { UpstreamError, ValidationError } from '../../platform/errors.ts';
import { createSafeFetch, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from '../connections/deps.ts';

export type ImportSource =
  | { kind: 'file'; name: string; csv: string }
  | { kind: 'url'; url: string };

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const objectKeyOf = (orgId: string, id: string): string =>
  `uploads/pass-imports/${orgId}/${id}.csv`;

/** The file bytes: the uploaded text, or one fetch of the sheet link. Redirects are refused (safe-fetch). */
export async function sourceBytes(ctx: ServiceContext, source: ImportSource): Promise<Uint8Array> {
  if (source.kind === 'file') return new TextEncoder().encode(source.csv);
  const deps = getDeps();
  const fetchSafe = createSafeFetch({
    platformHosts: platformHostsOf(ctx.env),
    maxBytes: PASS_IMPORT_MAX_BYTES,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
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
    return parseCsv(bytes);
  } catch (error) {
    if (error instanceof CsvError) throw new ValidationError(error.message, [], error.code);
    throw error;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
