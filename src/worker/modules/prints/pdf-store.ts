/** Printed-ticket PDFs in R2. They hold the print code, so they are read only through an authorized route. */
export const pdfKey = (orgId: string, passId: string, printId: string): string =>
  `prints/${orgId}/${passId}/${printId}.pdf`;
export const bulkKey = (orgId: string, jobId: string, ext: 'pdf' | 'json'): string =>
  `prints/${orgId}/bulk/${jobId}.${ext}`;

export type PdfEngine = 'browser' | 'fallback';

const FALLBACK_RETRY_MS = 5 * 60_000;

/** A cached PDF is good while the pass is at the version it was drawn from. */
export async function cachedPdf(
  bucket: R2Bucket,
  key: string,
  passVersion: number,
  options: { browserBound: boolean; now: number },
): Promise<R2ObjectBody | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const meta = object.customMetadata ?? {};
  if (meta.passVersion !== String(passVersion)) return null;
  // A fallback copy is redrawn once Browser Run is back (it may have been a short outage).
  const age = options.now - object.uploaded.getTime();
  if (meta.engine === 'fallback' && options.browserBound && age > FALLBACK_RETRY_MS) return null;
  return object;
}

export async function putPdf(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  meta: { passVersion?: number; engine: PdfEngine },
): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      engine: meta.engine,
      ...(meta.passVersion === undefined ? {} : { passVersion: String(meta.passVersion) }),
    },
  });
}

/** Deletes every PDF of a pass (all prints). */
export async function deletePassPdfs(bucket: R2Bucket, orgId: string, passId: string) {
  const prefix = `prints/${orgId}/${passId}/`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
