/**
 * Reads a body through a running byte count and aborts as soon as `max` is exceeded.
 * `declared` is the Content-Length header, checked before any byte is read.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  tooLarge: () => Error,
  declared = 0,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (declared > max) throw tooLarge();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Cancelling resolves a pending read as done, so the abort is checked after every read.
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Body read aborted.');
    }
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      signal?.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  signal?.removeEventListener('abort', cancel);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
