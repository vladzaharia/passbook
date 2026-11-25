import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVELOPERS_INDEXABLE, NOT_FOUND_FILE, PATHS, twin } from '../src/shared/developers.ts';
import { loadInputs } from '../src/web/developers/model/load.ts';
import { buildSite } from '../src/web/developers/model/site.ts';
import { INDEX_BUDGET_GZIP } from '../src/web/developers/search/build.ts';
import type { SearchIndex } from '../src/web/developers/search/types.ts';
import { buildDevelopers, headTags, type Manifest } from './build-developers.ts';

const root = resolve(import.meta.dirname, '..');
const HEAD =
  '<script type="module" crossorigin src="/assets/developers-X.js"></script><link rel="stylesheet" crossorigin href="/assets/developers-X.css">';
const work = mkdtempSync(join(tmpdir(), 'developers-'));
const out = join(work, 'client');
const api = join(work, 'api');
let manifest: Manifest;
const site = buildSite(loadInputs(root));

const read = (file: string) => readFileSync(join(out, file), 'utf8');
const ids = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
const hrefs = (html: string) => [...html.matchAll(/ href="([^"]+)"/g)].map((m) => m[1] ?? '');

beforeAll(async () => {
  // Give one operation x-codes and two guide entries to prove the table renders. errors.json stays the real catalog: the guides link to its codes.
  mkdirSync(api, { recursive: true });
  cpSync(join(root, 'docs/api'), api, { recursive: true });
  const docPath = join(api, 'openapi.v1.json');
  const doc = JSON.parse(readFileSync(docPath, 'utf8'));
  doc.paths['/api/v1/passes'].post['x-codes'] = ['VALIDATION', 'PASS_CONFLICT'];
  writeFileSync(docPath, JSON.stringify(doc));
  writeFileSync(
    join(api, 'error-guide.json'),
    JSON.stringify({
      VALIDATION: { title: 'Invalid request', fix: 'Fix the fields listed in issues.' },
      PASS_CONFLICT: { title: 'Pass conflict', fix: 'This serial exists. Use another or omit it.' },
    }),
  );
  mkdirSync(out, { recursive: true });
  manifest = (
    await buildDevelopers({ out, head: HEAD, apiDir: api, origin: 'https://passbook.mobile' })
  ).manifest;
}, 120_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('build-developers', () => {
  it('writes a page and a twin per resource, and one of each per operation', () => {
    for (const page of site.pages) {
      const url = `/developers/reference/${page.slug}`;
      expect(manifest[url], url).toBeDefined();
      expect(manifest[`${url}.md`], url).toBeDefined();
      const html = read(`${url}.html`);
      expect(html.match(/<a class="lrow oprow"/g)?.length, page.key).toBe(page.ops.length);
      expect(read(`${url}.md`)).toContain(`# ${page.label}`);
      for (const op of page.ops) {
        const opUrl = `${url}/${op.anchor.toLowerCase()}`;
        expect(manifest[opUrl], opUrl).toBeDefined();
        expect(manifest[`${opUrl}.md`], opUrl).toBeDefined();
        expect(read(`${opUrl}.html`).match(/<section class="op"/g)?.length, opUrl).toBe(1);
      }
    }
  });

  it('writes a markdown twin for every page, and llms.txt links only to twins that exist', () => {
    for (const [url, entry] of Object.entries(manifest))
      if (entry.type.startsWith('text/html') && url !== NOT_FOUND_FILE)
        expect(manifest[twin(url)], url).toBeDefined();
    for (const m of read('/developers/llms.txt').matchAll(
      /\]\(https:\/\/passbook\.mobile(\/[^)]+)\)/g,
    ))
      expect(manifest[m[1] ?? ''], m[1]).toBeDefined();
  });

  it('keeps every old anchor: a row per operation on its resource page, the ids on its own page', () => {
    const seen = new Set<string>();
    for (const page of site.pages) {
      const html = read(`/developers/reference/${page.slug}.html`);
      const have = ids(html);
      for (const op of page.ops) {
        const own = `/developers/reference/${page.slug}/${op.anchor.toLowerCase()}`;
        expect(seen.has(own), `${own} is not unique`).toBe(false);
        seen.add(own);
        expect(have.has(op.anchor), `${page.slug}#${op.anchor}`).toBe(true);
        expect(html).toContain(`data-alias="${op.operationId}" href="${own}"`);
        const page2 = ids(read(`${own}.html`));
        expect(page2.has(op.anchor), own).toBe(true);
        expect(page2.has(op.operationId), op.operationId).toBe(true);
      }
      for (const href of hrefs(html).filter((h) => h.startsWith('#')))
        expect(have.has(href.slice(1)), `${page.slug} ${href}`).toBe(true);
    }
  });

  it('links only to pages and files that exist', () => {
    const served = new Set(Object.keys(manifest));
    const outside = [
      '/login',
      '/auth/',
      '/api/v1/openapi.json',
      '/favicon',
      '/apple-touch-icon.png',
      '/theme-init.js',
      '/assets/',
      '/fonts/',
    ];
    for (const [url, entry] of Object.entries(manifest)) {
      if (!entry.type.startsWith('text/html')) continue;
      for (const href of hrefs(
        read(entry.asset.endsWith('/') ? `${entry.asset}index.html` : `${entry.asset}.html`),
      )) {
        const [path, hash] = href.split('#') as [string, string | undefined];
        if (!path.startsWith('/') || outside.some((o) => path.startsWith(o))) continue;
        expect(served.has(path), `${url} -> ${href}`).toBe(true);
        // The console's operation ids come from its island, not from the page.
        if (hash && !path.endsWith('.md') && path !== '/developers/console') {
          const asset = manifest[path]?.asset ?? '';
          const file = asset.endsWith('/') ? `${asset}index.html` : `${asset}.html`;
          expect(ids(read(file)).has(hash), `${url} -> ${href}`).toBe(true);
        }
      }
    }
  });

  it('renders the errors table from x-codes, with fixes from the catalog, and an entry per code', () => {
    const html = read('/developers/reference/passes/create.html');
    expect(html).toContain('<table class="errs">');
    expect(html).toContain('All ');
    expect(html).toContain('This serial exists. Use another or omit it.');
    expect(html).toContain('href="/developers/errors/PASS_CONFLICT"');
    expect(read('/developers/errors/PASS_CONFLICT.html')).toContain('Returned by');
    expect(read('/developers/errors/index.html')).toContain('VALIDATION');
  });

  it('carries no inline script, style or event handler (the CSP allows none)', () => {
    for (const [url, entry] of Object.entries(manifest)) {
      if (!entry.type.startsWith('text/html')) continue;
      const html = read(
        entry.asset.endsWith('/') ? `${entry.asset}index.html` : `${entry.asset}.html`,
      );
      expect(html, url).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(html, url).not.toMatch(/<style|\sstyle="|\son[a-z]+="/);
      expect(html.includes('name="robots"'), url).toBe(!DEVELOPERS_INDEXABLE);
      if (url !== NOT_FOUND_FILE)
        expect(html, url).toContain(`rel="canonical" href="https://passbook.mobile${url}"`);
    }
  });

  it('writes llms.txt, a sitemap and a manifest that the Worker serves from', () => {
    const llms = read('/developers/llms.txt');
    for (const page of site.pages) expect(llms).toContain(`/developers/reference/${page.slug}.md`);
    expect(read('/developers/sitemap.xml')).toContain(
      '<loc>https://passbook.mobile/developers</loc>',
    );
    expect(manifest['/developers']).toEqual({
      asset: '/developers/',
      type: 'text/html; charset=utf-8',
    });
    expect(manifest['/developers/llms.txt']?.type).toBe('text/plain; charset=utf-8');
  });

  it('keeps the key out of every page and every sample', () => {
    for (const entry of Object.values(manifest)) {
      const file = entry.type.startsWith('text/html')
        ? entry.asset.endsWith('/')
          ? `${entry.asset}index.html`
          : `${entry.asset}.html`
        : entry.asset;
      expect(read(file)).not.toMatch(
        /pb_(live|test)_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
      );
    }
  });

  it('builds the playground page, the starters’ previews and one static paper image each, all served from the manifest', () => {
    expect(manifest['/developers/playground']?.type).toMatch(/^text\/html/);
    expect(read('/developers/playground.html')).toContain('data-island="playground"');
    const entry = manifest['/developers/blueprint-previews.json'];
    expect(entry?.type).toBe('application/json; charset=utf-8');
    const data = JSON.parse(read('/developers/blueprint-previews.json')) as {
      items: { slug: string; paper: { src: string } }[];
    };
    expect(data.items.length).toBeGreaterThan(20);
    for (const item of data.items) {
      expect(manifest[item.paper.src]?.type, item.slug).toBe('image/svg+xml');
      expect(read(item.paper.src).startsWith('<svg'), item.slug).toBe(true);
    }
  });

  it('writes the ⌘K index, and every link in it lands on a page and an anchor the build made', () => {
    const entry = manifest[PATHS.searchIndex];
    expect(entry?.type).toBe('application/json; charset=utf-8');
    const index = JSON.parse(read(PATHS.searchIndex)) as SearchIndex;
    expect(index.v).toBe(1);
    expect(gzipSync(read(PATHS.searchIndex)).length).toBeLessThan(INDEX_BUDGET_GZIP);
    const rows = [
      ...index.errors,
      ...index.ops,
      ...index.guides,
      ...index.events,
      ...index.actions,
    ];
    expect(rows.length).toBeGreaterThan(500);
    for (const { href } of rows) {
      const [path = '', anchor] = href.split('#');
      // The admin app's own pages are not the portal's.
      if (path.startsWith('/admin/')) continue;
      const page = manifest[path];
      expect(page?.type, href).toMatch(/^text\/html/);
      if (!anchor) continue;
      const file = page?.asset.endsWith('/') ? `${page.asset}index.html` : `${page?.asset}.html`;
      expect(ids(read(file)), href).toContain(anchor);
    }
  });

  it('takes the script and stylesheet tags from the Vite document', () => {
    expect(headTags(`<html><head><title>x</title>${HEAD}</head></html>`)).toBe(HEAD);
    expect(read('/developers/index.html')).toContain(HEAD);
  });
});
