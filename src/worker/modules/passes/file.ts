import { PKPASS_CONTENT_TYPE } from '../../../passkit/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { assertSignedObject } from '../developer/fence.ts';
import type { Pass } from './repo.ts';

const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** `<org-slug>-<title-slug>.pkpass` ("henrys-maya-chen.pkpass"); the serial stands in for a title. */
export function passFileName(pass: Pick<Pass, 'orgSlug' | 'displayTitle' | 'serial'>): string {
  const parts = [pass.orgSlug ?? '', slug(pass.displayTitle ?? '') || slug(pass.serial)].filter(
    Boolean,
  );
  return `${parts.join('-') || 'pass'}.pkpass`;
}

/** Where the voided Apple variant of a version is cached; every purge of the version deletes it too. */
export const voidedKey = (passId: string, version: number) =>
  `passes/${passId}/v${version}-voided.pkpass`;

/** A built variant of the pass's file (the voided Apple copy) served in place of the stored object. */
export interface PassFileVariant {
  objectKey: string;
  name: string;
  /** Builds the object; runs only when bytes are served, never for a 304. */
  ensure?: () => Promise<void>;
  /** Builds the bytes in place of reading `objectKey` (a timed render); runs only when bytes are served. */
  render?: () => Promise<Uint8Array>;
  /** When the variant changed after the pass's own publish: Last-Modified moves with it. */
  modifiedAt?: number;
}

// A render is signed again on each fetch, so its bytes differ while its content does not: a weak tag.
const etagOf = (pass: Pass, variant?: PassFileVariant) =>
  `${variant?.render ? 'W/' : ''}"${pass.objectSha256 ?? `v${pass.version}`}${variant ? `-${variant.name}` : ''}"`;

const second = (ms: number) => Math.floor(ms / 1000);

function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const tag = etag.replace(/^W\//, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === tag);
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
  variant?: PassFileVariant,
): Promise<Response> {
  assertSignedObject(variant?.objectKey ?? pass.objectKey);
  const etag = etagOf(pass, variant);
  const later = variant?.modifiedAt !== undefined && variant.modifiedAt > pass.modifiedAt;
  const modifiedSeconds = second(later ? (variant?.modifiedAt ?? 0) : pass.modifiedAt);
  // A variant made in the second of the publish it follows cannot be told apart by the timestamp.
  const collision =
    pass.modifiedCollision || (later && modifiedSeconds === second(pass.modifiedAt));
  const headers = new Headers({
    'content-type': PKPASS_CONTENT_TYPE,
    etag,
    'last-modified': new Date(modifiedSeconds * 1000).toUTCString(),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  const noneMatch = request.headers.get('if-none-match');
  const since = request.headers.get('if-modified-since');
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const notModified = noneMatch
    ? matchesEtag(noneMatch, etag)
    : !collision && Number.isFinite(sinceMs) && modifiedSeconds * 1000 <= sinceMs;
  if (notModified) return new Response(null, { status: 304, headers });
  headers.set('content-disposition', `attachment; filename="${passFileName(pass)}"`);
  if (variant?.render) {
    // HEAD neither renders nor signs: the length is only known once the body is built.
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const bytes = await variant.render();
    headers.set('content-length', String(bytes.byteLength));
    return new Response(bytes as BodyInit, { status: 200, headers });
  }
  await variant?.ensure?.();
  const object = await bucket.get(variant?.objectKey ?? pass.objectKey);
  if (!object) throw new NotFoundError('The pass file is missing.', 'PASS_FILE_MISSING');
  headers.set('content-length', String(object.size));
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
