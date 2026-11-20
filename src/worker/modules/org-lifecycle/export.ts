import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { ServiceContext } from '../../platform/service-context.ts';
import { exportRunning } from './repo.ts';
import { EXPORT_ENTITIES, type ExportEntity, exportPage } from './repo-export.ts';

const PAGE_ROWS = 2000;
const PART_BYTES = 8 * 1024 * 1024;
/** The archive is a download for admins, not storage: it goes after a week. */
export const EXPORT_KEEP_MS = 7 * 86_400_000;
/** A link is good for a day. */
export const LINK_MS = 86_400_000;
/** Stops a runaway: an archive over this many bytes of files fails with `ORG_EXPORT_TOO_LARGE`. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export const exportKey = (orgId: string, id: string) => `exports/${orgId}/${id}.zip`;
const partKey = (orgId: string, id: string, entity: string, n: number) =>
  `exports/${orgId}/${id}/parts/${entity}-${String(n).padStart(6, '0')}.ndjson`;
const partsPrefix = (orgId: string, id: string) => `exports/${orgId}/${id}/parts/`;
const templateFilesPrefix = (orgId: string) => `templates/${orgId}/`;

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
  const flush = async (force: boolean) => {
    if (size === 0 || (!force && size < PART_BYTES)) return;
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of pending) {
      body.set(c, at);
      at += c.length;
    }
    parts.push(await upload.uploadPart(parts.length + 1, body));
    total += size;
    pending = [];
    size = 0;
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
    for (const object of await listAll(bucket, templateFilesPrefix(orgId))) {
      fileBytes += object.size;
      if (fileBytes > MAX_FILE_BYTES) throw new Error('ORG_EXPORT_TOO_LARGE');
      const body = new Uint8Array(
        (await (await bucket.get(object.key))?.arrayBuffer()) ?? new ArrayBuffer(0),
      );
      const entry = new ZipPassThrough(
        `template-files/${object.key.slice(templateFilesPrefix(orgId).length)}`,
      );
      zip.add(entry);
      entry.push(body, true);
      await flush(false);
    }
    zip.end();
    await flush(true);
    await upload.complete(parts);
  } catch (error) {
    await upload.abort();
    throw error;
  }
  counts.template_files = (await listAll(bucket, templateFilesPrefix(orgId))).length;
  return { bytes: total, entities: counts };
}

/** The staged parts are gone once the archive exists. */
export async function dropParts(ctx: ServiceContext, orgId: string, id: string): Promise<void> {
  const bucket = ctx.env.BUCKET;
  const objects = await listAll(bucket, partsPrefix(orgId, id));
  for (let i = 0; i < objects.length; i += 500)
    await bucket.delete(objects.slice(i, i + 500).map((o) => o.key));
}
