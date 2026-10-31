import { PKPASS_CONTENT_TYPE } from '../../../passkit/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { Pass } from './repo.ts';

const etagOf = (pass: Pass) => `"${pass.objectSha256 ?? `v${pass.version}`}"`;

function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === etag);
}

/**
 * The signed .pkpass with conditional-request handling. `If-None-Match` wins over
 * `If-Modified-Since`; when two publishes share a second the timestamp is ignored so a change is
 * never hidden behind a 304.
 */
export async function servePassFile(
  bucket: R2Bucket,
  pass: Pass,
  request: Request,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const etag = etagOf(pass);
  const modifiedSeconds = Math.floor(pass.modifiedAt / 1000);
  const headers = new Headers({
    'content-type': PKPASS_CONTENT_TYPE,
    etag,
    'last-modified': new Date(modifiedSeconds * 1000).toUTCString(),
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  const noneMatch = request.headers.get('if-none-match');
  const since = request.headers.get('if-modified-since');
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const notModified = noneMatch
    ? matchesEtag(noneMatch, etag)
    : !pass.modifiedCollision && Number.isFinite(sinceMs) && modifiedSeconds * 1000 <= sinceMs;
  if (notModified) return new Response(null, { status: 304, headers });
  const object = await bucket.get(pass.objectKey);
  if (!object) throw new NotFoundError('The pass file is missing.', 'PASS_FILE_MISSING');
  headers.set('content-length', String(object.size));
  headers.set(
    'content-disposition',
    `attachment; filename="${pass.serial.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.pkpass"`,
  );
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
