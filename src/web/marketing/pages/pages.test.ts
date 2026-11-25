import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const sources = [...walk(join(ROOT, 'marketing')), ...walk(join(ROOT, 'src/web/marketing'))].filter(
  (p) => !p.endsWith('.test.ts'),
);
const page = (name: string) => readFileSync(join(ROOT, 'marketing', `${name}.html`), 'utf8');

describe('marketing pages', () => {
  it('carry no address that leaves the origin', () => {
    const NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
    const found = sources.flatMap((p) =>
      (readFileSync(p, 'utf8').match(/https?:\/\/[^\s"'<>)]*/g) ?? [])
        .filter((u) => !NAMESPACES.includes(u))
        .map((u) => `${p}: ${u}`),
    );
    expect(found).toEqual([]);
  });

  it('inline no style or script and load one module entry each', () => {
    for (const name of ['index', 'door', 'blueprints', 'build', 'access']) {
      const html = page(name);
      expect(html, name).not.toMatch(/<style[\s>]/);
      expect(html, name).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(
        html.match(/<script type="module" src="\/src\/web\/marketing\/pages\/\w+\.ts">/g),
      ).toHaveLength(1);
      expect(html, name).toContain('<link rel="canonical" href="%PUBLIC_BASE_URL%/');
    }
  });

  it('link only to the site paths', () => {
    for (const name of ['index', 'door', 'blueprints', 'build', 'access']) {
      expect(page(name), name).not.toMatch(/href="[a-z]+\.html/);
    }
  });

  it('lists every starter once on the blueprints page', () => {
    const starters = readdirSync(join(ROOT, 'templates')).filter((n) => n.startsWith('starter-'));
    const items = page('blueprints').match(/class="bp-item"/g) ?? [];
    expect(items).toHaveLength(23);
    expect(items).toHaveLength(starters.length);
  });

  it('posts the access form without script and names its fields', () => {
    const html = page('access');
    expect(html).toContain('method="post" action="/access"');
    expect(html).not.toContain('novalidate');
    for (const n of ['name', 'email', 'org', 'purpose', 'message', 'website'])
      expect(html).toContain(`name="${n}"`);
    expect(html).toContain('id="acc-send-e"');
  });
});
