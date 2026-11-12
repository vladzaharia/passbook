export type WalletRuntimeResponseStage = 'google-class' | 'google-object' | 'samsung-update';

/** Server-only sensitive response. Persist encrypted immediately; never log or return its body. */
export interface WalletRuntimeProviderResponse {
  stage: WalletRuntimeResponseStage;
  method: 'GET' | 'POST' | 'PATCH';
  status: number;
  body: Uint8Array;
}

export type WalletRuntimeResponseSink = (response: WalletRuntimeProviderResponse) => Promise<void>;

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Read once, bounded, and reconstruct the response for the adapter after encrypted persistence. */
export async function captureRuntimeResponse(
  response: Response,
  stage: WalletRuntimeResponseStage,
  method: 'GET' | 'POST' | 'PATCH',
  sink: WalletRuntimeResponseSink,
): Promise<Response> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_RESPONSE_BYTES - length) {
        // Do not await cancellation: provider streams can hold cancellation open indefinitely.
        void reader.cancel().catch(() => undefined);
        throw new Error('Provider response exceeds the capture limit.');
      }
      chunks.push(value);
      length += value.byteLength;
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 204, 205 and 304 cannot have a Response body, even an empty byte array.
  const copy = new Response(
    response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : (body as BufferSource),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
  await sink({ stage, method, status: response.status, body });
  return copy;
}
