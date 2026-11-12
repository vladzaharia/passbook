import { PayloadTooLargeError } from '../../platform/errors.ts';

export const SAMSUNG_CALLBACK_BODY_LIMIT = 16 * 1024;

/** Counts actual streamed bytes even if an untrusted Content-Length is smaller. */
export async function readSamsungCallbackBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > SAMSUNG_CALLBACK_BODY_LIMIT)) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SAMSUNG_CALLBACK_BODY_LIMIT) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
