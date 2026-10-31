import { readFileSync } from 'node:fs';
import type { Download } from '@playwright/test';
import { unzipSync } from 'fflate';

/** Reads a downloaded .pkpass and returns its archive entries plus the parsed pass.json. */
export async function readPkpass(download: Download) {
  const path = await download.path();
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const passJson = JSON.parse(new TextDecoder().decode(files['pass.json'])) as Record<
    string,
    unknown
  >;
  return { files, names: Object.keys(files), passJson };
}
