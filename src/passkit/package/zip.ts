import { Zip, ZipPassThrough, zipSync } from 'fflate';
import type { SignedPass } from '../sign/index.ts';

export const PKPASS_CONTENT_TYPE = 'application/vnd.apple.pkpass';
export const PKPASSES_CONTENT_TYPE = 'application/vnd.apple.pkpasses';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array | (() => Promise<Uint8Array>);
}

const FIXED_MTIME = Date.UTC(2020, 0, 1);

/** Streaming STORE-only zip. Files are emitted one per pull, so memory stays flat for large bundles. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  let index = 0;
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) controller.error(error);
        else {
          if (chunk.length > 0) controller.enqueue(chunk);
          if (final) controller.close();
        }
      });
    },
    async pull() {
      const entry = entries[index++];
      if (!entry) {
        zip.end();
        return;
      }
      const bytes = typeof entry.bytes === 'function' ? await entry.bytes() : entry.bytes;
      const file = new ZipPassThrough(entry.name);
      file.mtime = FIXED_MTIME;
      zip.add(file);
      file.push(bytes, true);
    },
    cancel() {
      zip.terminate();
    },
  });
}

function passEntries(signed: SignedPass, prefix = ''): ZipEntry[] {
  return Object.keys(signed.files)
    .sort()
    .map((name) => ({ name: `${prefix}${name}`, bytes: signed.files[name] as Uint8Array }));
}

/** .pkpass as a streaming zip (STORE: PNGs are already compressed). */
export function packagePass(signed: SignedPass): ReadableStream<Uint8Array> {
  return zipStream(passEntries(signed));
}

/** .pkpass as bytes, for R2 puts and email attachments. */
export function packagePassBytes(signed: SignedPass): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0; mtime: number }]> = {};
  for (const name of Object.keys(signed.files).sort()) {
    files[name] = [signed.files[name] as Uint8Array, { level: 0, mtime: FIXED_MTIME }];
  }
  return zipSync(files);
}

/** .pkpasses bundle: a zip of complete .pkpass files. */
export function packagePasses(
  passes: { name: string; bytes: Uint8Array | (() => Promise<Uint8Array>) }[],
): ReadableStream<Uint8Array> {
  return zipStream(
    passes.map((pass, i) => ({
      name: pass.name.endsWith('.pkpass') ? pass.name : `${pass.name || `pass-${i + 1}`}.pkpass`,
      bytes: pass.bytes,
    })),
  );
}
