import type { z } from 'zod';
import type { UploadConnectionFileSchema } from '@/shared/contracts/connection-files.ts';

export type UploadBody = z.input<typeof UploadConnectionFileSchema>;

const STEP = 0x8000;

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

/**
 * The upload body for a file: UTF-8 text goes as text, anything else (XLSX, or a file that is not
 * UTF-8) as base64. The server sniffs the format from the bytes and refuses what it cannot read.
 */
export async function readUpload(file: File): Promise<UploadBody> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { name: file.name, content, encoding: 'utf8' };
    } catch {
      // Not UTF-8: sent as bytes, so the server can name what it is.
    }
  }
  return { name: file.name, content: base64(bytes), encoding: 'base64' };
}
