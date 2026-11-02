/**
 * Reads a body through a running byte count and aborts as soon as `max` is exceeded.
 * `declared` is the Content-Length header, checked before any byte is read.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  tooLarge: () => Error,
  declared = 0,
): Promise<Uint8Array> {
  if (declared > max) throw tooLarge();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
