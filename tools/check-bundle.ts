// Runs after `vite build`: the initial load (entry plus modulepreloads) stays under budget and
// carries no admin-only library.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/client');

/** Initial gzip bytes measured after the admin-only libraries left the entry (217,649), plus 5%. */
export const BUDGET_BYTES = 228_500;
export const FORBIDDEN = ['cmdk-', 'getRowModel', 'measureElement'] as const;

export function initialAssets(html: string): string[] {
  const urls = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1] ?? '');
  return urls.filter(Boolean);
}

export function checkBundle(
  read: (url: string) => string,
  html: string,
  budget: number,
): { total: number; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  for (const url of initialAssets(html)) {
    const body = read(url);
    total += gzipSync(body).length;
    for (const marker of FORBIDDEN) {
      if (body.includes(marker)) errors.push(`${url} contains ${marker}`);
    }
  }
  if (budget > 0 && total > budget)
    errors.push(`initial gzip ${total} B exceeds budget ${budget} B`);
  return { total, errors };
}

if (import.meta.main) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const { total, errors } = checkBundle(
    (url) => readFileSync(join(dist, url.replace(/^\//, '')), 'utf8'),
    html,
    BUDGET_BYTES,
  );
  process.stdout.write(`initial gzip: ${total} B\n`);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exit(1);
  }
}
