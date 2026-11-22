import type { APIRequestContext } from '@playwright/test';
import { unzipSync } from 'fflate';

/** Safari on a Mac: the pass page offers the badge beside the QR (elsewhere off Apple's devices only the QR). */
export const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/** Chrome on a Pixel: the pass page leads with "Save to this phone" while no native wallet is live. */
export const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** A phone that adds the pass: reads the pass's own web-service address and token from its .pkpass, then registers a device. */
export async function registerStubDevice(
  api: { ctx: APIRequestContext },
  downloadUrl: string,
  device = `stub-${Math.random().toString(16).slice(2, 10)}`,
): Promise<{ device: string; serial: string }> {
  const res = await api.ctx.get(downloadUrl);
  if (!res.ok()) throw new Error(`GET ${downloadUrl} -> ${res.status()}`);
  const files = unzipSync(new Uint8Array(await res.body()));
  const pass = JSON.parse(new TextDecoder().decode(files['pass.json'])) as {
    authenticationToken: string;
    serialNumber: string;
    passTypeIdentifier: string;
    webServiceURL: string;
  };
  const url = `${pass.webServiceURL}/v1/devices/${device}/registrations/${pass.passTypeIdentifier}/${pass.serialNumber}`;
  const registered = await api.ctx.post(url, {
    headers: { authorization: `ApplePass ${pass.authenticationToken}` },
    data: { pushToken: 'ab'.repeat(32) },
  });
  if (registered.status() !== 201) throw new Error(`register -> ${registered.status()}`);
  return { device, serial: pass.serialNumber };
}
