/** Printed-ticket PDFs in R2. They hold the print code, so they are read only through an authorized route. */
/** A holder's PDF is drawn on a home sheet, staff's at the exact page, so each has its own object. */
export const pdfKey = (
  orgId: string,
  passId: string,
  printId: string,
  audience: 'holder' | 'staff' = 'staff',
): string => `prints/${orgId}/${passId}/${printId}${audience === 'holder' ? '.holder' : ''}.pdf`;
export const bulkKey = (orgId: string, jobId: string, ext: 'pdf' | 'json'): string =>
  `prints/${orgId}/bulk/${jobId}.${ext}`;

/** A cached PDF is good while the pass is at the version it was drawn from and the drawing inputs match. */
export async function cachedPdf(
  bucket: R2Bucket,
  key: string,
  passVersion: number,
  fingerprint: string,
): Promise<R2ObjectBody | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const meta = object.customMetadata ?? {};
  if (meta.passVersion !== String(passVersion) || meta.fingerprint !== fingerprint) {
    await object.body.cancel();
    return null;
  }
  return object;
}

export async function putPdf(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  meta: { passVersion?: number; fingerprint?: string } = {},
): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      ...(meta.passVersion === undefined ? {} : { passVersion: String(meta.passVersion) }),
      ...(meta.fingerprint === undefined ? {} : { fingerprint: meta.fingerprint }),
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

const MARKER = 'bulk-';
/** A one-line object under the pass's prefix naming a bulk job that holds the pass, so a drop can find it. */
export const bulkMarkerKey = (orgId: string, passId: string, jobId: string): string =>
  `prints/${orgId}/${passId}/${MARKER}${jobId}`;

/**
 * Deletes every bulk PDF that holds this pass, found by its markers. The status stays (a job still
 * pending renders without the pass and counts it skipped; a ready one answers 404 for the file).
 */
export async function deleteBulkOfPass(bucket: R2Bucket, orgId: string, passId: string) {
  const prefix = `prints/${orgId}/${passId}/${MARKER}`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.flatMap((o) => {
      const jobId = o.key.slice(prefix.length);
      return [o.key, bulkKey(orgId, jobId, 'pdf')];
    });
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
