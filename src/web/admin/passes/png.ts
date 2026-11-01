const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The server's limit (modules/passes/assets.ts). */
export const MAX_ASSET_BYTES = 1_000_000;
export const MAX_ASSET_SIDE = 4096;

function readHead(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file.slice(0, 33));
  });
}

export interface PngCheck {
  ok: boolean;
  message?: string;
  width?: number;
  height?: number;
}

/** Checks the signature and IHDR so obvious mistakes fail before upload. */
export async function checkPng(file: File): Promise<PngCheck> {
  if (file.size > MAX_ASSET_BYTES) {
    return { ok: false, message: 'The image is over 1 MB. Export a smaller PNG.' };
  }
  const head = await readHead(file);
  if (head.length < 24 || SIGNATURE.some((b, i) => head[i] !== b)) {
    return { ok: false, message: 'Not a PNG file.' };
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > MAX_ASSET_SIDE || height > MAX_ASSET_SIDE) {
    return { ok: false, message: `Dimensions must be 1 to ${MAX_ASSET_SIDE} px.`, width, height };
  }
  return { ok: true, width, height };
}

export function assetName(slot: string, scale: 1 | 2 | 3): string {
  return scale === 1 ? `${slot}.png` : `${slot}@${scale}x.png`;
}
