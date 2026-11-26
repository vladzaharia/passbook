import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The Workbench's tools, and the docs' pieces they share (the docs' ui, shell and search). */
const wb = join(import.meta.dirname, '..');
const dev = join(wb, '../developers');
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
  ...sources(join(wb, 'console')),
  ...sources(join(dev, 'ui')),
  ...sources(join(dev, 'shell')),
  ...sources(join(wb, 'keys')),
  ...sources(join(wb, 'tools')),
];
const islandFiles = [
  ...files,
  ...['webhooks', 'playground', 'logs', 'quickstart', 'home'].flatMap((d) => sources(join(wb, d))),
  ...sources(join(dev, 'search')),
];
const text = (f: string) => readFileSync(f, 'utf8');

describe('the page never stores, shows or addresses the try token', () => {
  it('token.ts uses no storage, cookie, URL or history API', () => {
    const t = text(join(wb, 'console/token.ts'));
    expect(t).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|location|history|caches|BroadcastChannel|postMessage|window\.name/,
    );
  });
  it('only the sender reads the token, and it goes into one header', () => {
    const readers = files.filter(
      (f) => /\btoken\(/.test(text(f)) && !f.endsWith('console/token.ts'),
    );
    expect(readers.map((f) => f.slice(wb.length + 1))).toEqual(['console/client.ts']);
    const send = text(join(wb, 'console/client.ts'));
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
    // The docs bar's companion link reads `from=workbench` alone (shell/workbench-link.ts).
    expect(uses.map((f) => f.slice(dev.length + 1))).toEqual(['shell/workbench-link.ts']);
  });
});
