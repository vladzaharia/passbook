import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What src/generated/ssr-controls.css is compiled from (tools/build-ssr-kit.ts). */
export const CONTROL_SOURCES = [
  'src/web/ui/button.tsx',
  'src/web/ui/input.tsx',
  'src/web/ui/label.tsx',
  'src/web/ui/callout.tsx',
  'src/web/styles/utilities.css',
  'node_modules/@polaris-key/brand/css/theme.css',
] as const;

/** What public/pass-tilt.js is bundled from. */
export const TILT_SOURCE = 'src/web/pass-card/tilt.ts';

/** A short digest of the files, stamped in the generated headers so a stale output fails a test. */
export function sourceHash(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(resolve(root, file)));
  return hash.digest('hex').slice(0, 12);
}
