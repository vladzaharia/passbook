import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { exportRunning } from './repo.ts';
import { EXPORT_ENTITIES, type ExportEntity, exportPage } from './repo-export.ts';

const PAGE_ROWS = 2000;
const PART_BYTES = 8 * 1024 * 1024;
/** The archive is a download for admins, not storage: it goes after a week. */
export const EXPORT_KEEP_MS = 7 * 86_400_000;
/** A link is good for an hour, and for one download. */
export const LINK_MS = 3_600_000;
/** Stops a runaway: an archive over this many bytes of files fails with `ORG_EXPORT_TOO_LARGE`. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export const exportKey = (orgId: string, id: string) => `exports/${orgId}/${id}.zip`;
const partKey = (orgId: string, id: string, entity: string, n: number) =>
  `exports/${orgId}/${id}/parts/${entity}-${String(n).padStart(6, '0')}.ndjson`;
const partsPrefix = (orgId: string, id: string) => `exports/${orgId}/${id}/parts/`;
/** The org's files in the archive: where they live in storage, and the folder they go to. */
const fileSets = (orgId: string) => [
  { count: 'template_files', prefix: `templates/${orgId}/`, dir: 'template-files/' },
  { count: 'brand_files', prefix: `orgs/${orgId}/branding/`, dir: 'brand-files/' },
  { count: 'member_photo_files', prefix: `member-photos/${orgId}/`, dir: 'member-photo-files/' },
];

export const entities = (): readonly ExportEntity[] => EXPORT_ENTITIES;

/** Pages written by one workflow step. */
const PAGES_PER_STEP = 10;

/** Up to ten pages of one entity as NDJSON parts from `after`. A repeat writes the same objects. */
export async function writeParts(
  ctx: ServiceContext,
  orgId: string,
  id: string,
  entity: ExportEntity,
  firstPart: number,
  after: number,
): Promise<{ last: number | null; next: number }> {
  if (!(await exportRunning(ctx.env.DB, id))) throw new Error('ORG_EXPORT_GONE');
  let cursor = after;
  let n = firstPart;
  for (let i = 0; i < PAGES_PER_STEP; i++, n++) {
    const { rows, last } = await exportPage(ctx.env.DB, entity, orgId, cursor, PAGE_ROWS);
    if (rows.length > 0)
      await ctx.env.BUCKET.put(
        partKey(orgId, id, entity.name, n),
        `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
        { httpMetadata: { contentType: 'application/x-ndjson' } },
      );
    if (rows.length < PAGE_ROWS || last === null) return { last: null, next: n + 1 };
    cursor = last;
  }
  return { last: cursor, next: n };
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 500 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Zips the parts and the org's template files into `exportKey`, streamed to a multipart upload so memory
 * stays near one part. Returns the size and the row counts by entity.
 */
export async function buildArchive(
  ctx: ServiceContext,
  orgId: string,
  id: string,
): Promise<{ bytes: number; entities: Record<string, number> }> {
  const bucket = ctx.env.BUCKET;
  if (!(await exportRunning(ctx.env.DB, id))) throw new Error('ORG_EXPORT_GONE');
  const upload = await bucket.createMultipartUpload(exportKey(orgId, id), {
    httpMetadata: { contentType: 'application/zip' },
  });
  const parts: R2UploadedPart[] = [];
  let pending: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    pending.push(chunk);
    size += chunk.length;
  });
  /** R2 wants equal parts except the last: send PART_BYTES at a time, keep the rest. */
  const flush = async (force: boolean) => {
    if (size === 0 || (!force && size < PART_BYTES)) return;
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of pending) {
      all.set(c, at);
      at += c.length;
    }
    let from = 0;
    while (size - from >= PART_BYTES || (force && from < size)) {
      const body = all.subarray(from, Math.min(from + PART_BYTES, size));
      parts.push(await upload.uploadPart(parts.length + 1, body));
      total += body.length;
      from += body.length;
    }
    pending = from < size ? [all.slice(from)] : [];
    size -= from;
  };
  const counts: Record<string, number> = {};
  try {
    const listed = await listAll(bucket, partsPrefix(orgId, id));
    for (const entity of EXPORT_ENTITIES) {
      const file = new ZipDeflate(`${entity.name}.ndjson`, { level: 6 });
      zip.add(file);
      const mine = listed.filter((o) => o.key.includes(`/parts/${entity.name}-`));
      let lines = 0;
      for (const [i, object] of mine.entries()) {
        const bytes = new Uint8Array(
          (await (await bucket.get(object.key))?.arrayBuffer()) ?? new ArrayBuffer(0),
        );
        for (const byte of bytes) if (byte === 10) lines++;
        file.push(bytes, i === mine.length - 1);
        await flush(false);
      }
      if (mine.length === 0) file.push(new Uint8Array(0), true);
      counts[entity.name] = lines;
    }
    let fileBytes = 0;
    for (const set of fileSets(orgId))
      for (const object of await listAll(bucket, set.prefix)) {
        fileBytes += object.size;
        if (fileBytes > MAX_FILE_BYTES) throw new Error('ORG_EXPORT_TOO_LARGE');
        const body = new Uint8Array(
          (await (await bucket.get(object.key))?.arrayBuffer()) ?? new ArrayBuffer(0),
        );
        const entry = new ZipPassThrough(`${set.dir}${object.key.slice(set.prefix.length)}`);
        zip.add(entry);
        entry.push(body, true);
        await flush(false);
      }
    zip.end();
    await flush(true);
    // A purge deletes the export row and sweeps the org's files: never complete an archive it did not see.
    if (!(await exportRunning(ctx.env.DB, id))) throw new Error('ORG_EXPORT_GONE');
    await upload.complete(parts);
    if (!(await exportRunning(ctx.env.DB, id))) {
      await bucket.delete(exportKey(orgId, id));
      throw new Error('ORG_EXPORT_GONE');
    }
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  for (const set of fileSets(orgId)) counts[set.count] = (await listAll(bucket, set.prefix)).length;
  return { bytes: total, entities: counts };
}

/** The staged parts are gone once the archive exists. */
export async function dropParts(ctx: ServiceContext, orgId: string, id: string): Promise<void> {
  const bucket = ctx.env.BUCKET;
  const objects = await listAll(bucket, partsPrefix(orgId, id));
  for (let i = 0; i < objects.length; i += 500)
    await bucket.delete(objects.slice(i, i + 500).map((o) => o.key));
}

export async function linkMac(
  env: object,
  orgId: string,
  exportId: string,
  exp: number,
): Promise<string> {
  const key = await derivedHmacKey(env, 'org-export-link.v1');
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${orgId}|${exportId}|${exp}`),
  );
  return toHex(new Uint8Array(mac));
}
