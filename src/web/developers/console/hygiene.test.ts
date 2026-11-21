import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dev = join(import.meta.dirname, '..');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !/test-support/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}
const files = [
  ...sources(join(dev, 'console')),
  ...sources(join(dev, 'ui')),
  ...sources(join(dev, 'shell')),
  ...sources(join(dev, 'keys')),
];
const islandFiles = [
  ...files,
  ...['webhooks', 'playground', 'logs', 'quickstart', 'search', 'keys', 'workbench'].flatMap((d) =>
    sources(join(dev, d)),
  ),
];
const text = (f: string) => readFileSync(f, 'utf8');

describe('the page never stores, shows or addresses the try token', () => {
  it('token.ts uses no storage, cookie, URL or history API', () => {
    const t = text(join(dev, 'console/token.ts'));
    expect(t).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|location|history|caches|BroadcastChannel|postMessage|window\.name/,
    );
  });
  it('only the sender reads the token, and it goes into one header', () => {
    const readers = files.filter(
      (f) => /\btoken\(/.test(text(f)) && !f.endsWith('console/token.ts'),
    );
    expect(readers.map((f) => f.slice(dev.length + 1))).toEqual(['console/send.ts']);
    const send = text(join(dev, 'console/send.ts'));
    expect(send.match(/Bearer /g)).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text being matched
    expect(send).toContain('authorization: `Bearer ${bearer}`');
  });
  it('no island code writes markup: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval', () => {
    for (const f of islandFiles) {
      if (f.endsWith('ui/code.tsx')) continue; // build-time pages only (prerender), not shipped in the island
      expect(text(f), f).not.toMatch(
        /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(|dangerouslySetInnerHTML=|new Function\(|\beval\(/,
      );
    }
  });
  it('the island does not read the URL beyond the operation id in the hash', () => {
    const uses = files.filter((f) => /location\.(search|href|pathname)/.test(text(f)));
    expect(uses.map((f) => f.slice(dev.length + 1))).toEqual([]);
  });
});
