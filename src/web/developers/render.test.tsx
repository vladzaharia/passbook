import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVED, PATHS } from '../../shared/developers.ts';
import { loadGuideInputs } from './guide/load.ts';
import { loadInputs } from './model/load.ts';
import { buildSite } from './model/site.ts';
import { renderSite } from './render.tsx';

const root = resolve(import.meta.dirname, '../../..');
const site = buildSite(loadInputs(root));
const ORIGIN = 'https://passbook.mobile';
const files = renderSite(
  site,
  ORIGIN,
  '<script type="module" src="/assets/developers.js"></script>',
);
const byFile = new Map(files.map((f) => [f.file, f]));
const body = (file: string) => byFile.get(file)?.body ?? '';
/** A page by its URL (a directory page's file is its index). */
const page = (url: string) =>
  files.find((f) => f.url === url && f.file.endsWith('.html'))?.body ?? '';

describe('the prerendered portal', () => {
  it('writes unique files, a page for each reference resource and its markdown twin', () => {
    expect(new Set(files.map((f) => f.file)).size).toBe(files.length);
    const urls = new Set(files.map((f) => f.url));
    for (const p of site.pages) {
      expect(urls.has(`${PATHS.reference}/${p.slug}`), p.slug).toBe(true);
      expect(byFile.has(`${PATHS.reference}/${p.slug}.md`), p.slug).toBe(true);
    }
    expect(body(PATHS.llms)).toMatch(/^# PassBook API/);
  });

  it('every html page carries the assets, a title and its own canonical origin', () => {
    const pages = files.filter((f) => f.url !== undefined && f.file.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(20);
    for (const f of pages) {
      expect(f.body, f.file).toContain('/assets/developers.js');
      expect(f.body, f.file).toMatch(/<title>[^<]+<\/title>/);
    }
  });

  it('lights the docs section a page belongs to and keeps the Workbench areas out of the bar', () => {
    const bar = (file: string) => {
      const html = body(file);
      return html.slice(html.indexOf('aria-label="Sections"'), html.indexOf('</nav>'));
    };
    const lit = (file: string) =>
      [...bar(file).matchAll(/aria-current="page"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    const guides = bar(`${PATHS.guides}/index.html`);
    expect([...guides.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual([
      'Quickstart',
      'Guides',
      'Reference',
      'Playground',
    ]);
    expect(guides).toContain('href="/workbench/quickstart"');
    expect(guides).toContain('href="/workbench/design"');
    expect(lit(`${PATHS.errors}/index.html`).concat(lit(`${PATHS.protocols}.html`))).toEqual([
      'Reference',
      'Reference',
    ]);
    expect(lit(`${PATHS.changelog}.html`)).toEqual([]);
  });

  it('builds no page for the moved tools; the Worker redirects their paths', () => {
    const built = new Set(files.map((f) => f.url));
    for (const from of Object.keys(MOVED)) expect(built.has(from), from).toBe(false);
    expect(files.some((f) => f.file.includes('bench-vt'))).toBe(false);
  });

  it('links Run in Workbench and See in Logs with no body in any URL (L19)', () => {
    const res = site.pages[0];
    const op = res?.ops[0];
    const err = site.errors[0];
    if (!res || !op || !err) throw new Error('no operation');
    const opHtml = page(`${PATHS.reference}/${res.slug}/${op.anchor.toLowerCase()}`);
    expect(opHtml).toContain(`href="/workbench/console?op=${op.operationId}"`);
    expect(opHtml).not.toContain('data-island="run"');
    expect(opHtml).not.toContain('data-try-bar');
    expect(page(`${PATHS.errors}/${err.code}`)).toContain(
      `href="/workbench/logs?code=${err.code}"`,
    );
    for (const f of files.filter((x) => x.file.endsWith('.html')))
      expect(f.body, f.file).not.toMatch(/href="\/workbench\/[^"]*[?&#]body=/);
  });

  it('opens the front page onto the Workbench: the hero and the card', () => {
    const home = page(PATHS.home);
    expect(home).toContain('href="/workbench/quickstart"');
    expect(home).toContain('href="/workbench/console?op=passes.postPasses"');
    expect(home).toContain('Open Workbench');
    expect(home).not.toContain('data-island="workbench"');
  });

  it('carries the companion link once in the bar and first in the sheet', () => {
    const html = page(PATHS.reference);
    const bar = /<header data-menubar[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(bar.match(/data-wb-link/g)).toHaveLength(1);
    expect(bar).toContain('href="/workbench/quickstart"');
    expect(bar).toContain('>Workbench<');
    expect(html.split('menu-sections')[1]).toMatch(
      /^"><a class="menu-wb" href="\/workbench\/quickstart"/,
    );
  });

  it('puts one tree on every page, with the page lit and its group open', () => {
    const tree = (url: string) => {
      const html = page(url);
      const at = html.indexOf('aria-label="Docs"');
      return html.slice(at, html.indexOf('</nav>', at));
    };
    const res = site.pages[0];
    const op = res?.ops[0];
    if (!res || !op) throw new Error('no operation');
    const opHref = `${PATHS.reference}/${res.slug}/${op.anchor.toLowerCase()}`;
    expect(tree(opHref)).toContain(`<a href="${opHref}" aria-current="page"`);
    expect(tree(opHref)).toContain('<details class="navg" open="">');
    expect(tree(PATHS.changelog)).toContain(`<a href="${PATHS.changelog}" aria-current="page"`);
    // The Workbench group is in every tree, the sheet's too, and its links are Workbench paths.
    for (const url of [PATHS.home, PATHS.guides, PATHS.errors]) {
      expect(tree(url), url).toContain('>Webhooks<');
      expect(tree(url), url).toContain('href="/workbench/events"');
    }
  });

  it('adds crumbs, Previous and Next, and "On this page" where the page is long', () => {
    const res = site.pages.find((p) =>
      p.ops.some((o) => o.fields.length > 0 && o.errors.length > 0),
    );
    const op = res?.ops.find((o) => o.fields.length > 0 && o.errors.length > 0);
    if (!res || !op) throw new Error('no operation');
    const html = page(`${PATHS.reference}/${res.slug}/${op.anchor.toLowerCase()}`);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('aria-label="Previous and next"');
    expect(html).toMatch(/<nav class="toc" aria-label="On this page" data-toc/);
    expect(html).toContain('>Parameters<');
    // Every entry points at an id on the page.
    for (const m of html.matchAll(/<li><a href="#([^"]+)">/g))
      expect(html, m[1]).toContain(`id="${m[1]}"`);
  });

  it('has the status and changelog pages and the feed', () => {
    const urls = files.map((f) => f.url).filter(Boolean);
    for (const path of [PATHS.status, PATHS.changelog]) expect(urls, path).toContain(path);
    expect(files.some((f) => f.file === PATHS.changelogFeed)).toBe(true);
    expect(body(PATHS.changelogFeed)).toContain('<feed');
    expect(body(PATHS.logsOps)).toContain('passes.');
  });

  it('writes the run files the Console reads, one per page and an index', () => {
    const runs = files.filter((f) => f.file.startsWith('/developers/run/'));
    expect(runs.length).toBe(site.pages.length + 1);
    expect(runs.some((f) => f.file.endsWith('/index.json'))).toBe(true);
    for (const f of runs) expect(() => JSON.parse(f.body)).not.toThrow();
  });

  it('opens every html page with the shared menubar and a Sign in the account island replaces', () => {
    const pages = files.filter((f) => f.url !== undefined && f.file.endsWith('.html'));
    for (const f of pages) {
      expect(f.body, f.file).toContain('<header data-menubar');
      expect(f.body, f.file).toContain('data-island="account"');
      expect(f.body, f.file).toMatch(
        /data-island="account"><a [^>]*href="[^"]*login[^"]*"[^>]*>Sign in</,
      );
      // The one-off bar this replaced.
      expect(f.body, f.file).not.toContain('class="top"');
      expect(f.body, f.file).not.toContain('foil-edge');
    }
  });

  it('links Developers sections from the bar and no other space', () => {
    const bar =
      /<header data-menubar[\s\S]*?<\/header>/.exec(
        files.find((f) => f.url === PATHS.home)?.body ?? '',
      )?.[0] ?? '';
    expect(bar).toContain(`href="${PATHS.reference}"`);
    expect(bar).not.toMatch(/href="\/(admin|account)?"/);
  });
});

describe('"On this page"', () => {
  const entries = (url: string) =>
    [...page(url).matchAll(/<li><a href="#([^"]+)">([^<]+)<\/a><\/li>/g)].map(
      (m) => m[1] as string,
    );

  it('keeps at least two entries on the errors index and the changelog, each an id on the page', () => {
    for (const url of [PATHS.errors, PATHS.changelog]) {
      const ids = entries(url);
      expect(ids.length, url).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(page(url), `${url}#${id}`).toContain(`id="${id}"`);
    }
  });

  it("lists a guide's sections and an operation's Parameters, Returns and Errors, with no Examples", () => {
    const withGuides = renderSite(site, ORIGIN, '', loadGuideInputs(root));
    const guide = withGuides.find(
      (f) => f.url?.startsWith(`${PATHS.guides}/`) && f.file.endsWith('.html'),
    );
    const listed = guide?.body.match(/<li><a href="#[^"]+">[^<]+<\/a><\/li>/g) ?? [];
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const res = site.pages.find((p) =>
      p.ops.some((o) => o.fields.length > 0 && o.errors.length > 0),
    );
    const op = res?.ops.find((o) => o.fields.length > 0 && o.errors.length > 0);
    if (!res || !op) throw new Error('no operation');
    const url = `${PATHS.reference}/${res.slug}/${op.anchor.toLowerCase()}`;
    const html = page(url);
    expect(html).toContain('>Parameters</a>');
    expect(html).not.toMatch(/<li><a href="#[^"]+">Examples</);
    for (const id of entries(url)) expect(html, id).toContain(`id="${id}"`);
  });

  it('drops the column when a page lists fewer than two sections', () => {
    expect(page(PATHS.status)).not.toContain('data-toc');
    expect(page(PATHS.status)).not.toContain('has-toc');
  });
});

describe("the frame's current marks", () => {
  it('says "page" on a section chip only on that section\'s own page, "true" inside it', () => {
    const chip = (url: string, name: string) =>
      new RegExp(`<a href="[^"]*"( aria-current="(\\w+)")?>${name}</a>`).exec(
        page(url).split('menu-sections')[1] ?? '',
      )?.[2];
    expect(chip(PATHS.reference, 'Reference')).toBe('page');
    expect(chip(PATHS.errors, 'Reference')).toBe('true');
    expect(chip(PATHS.errors, 'Guides')).toBeUndefined();
  });

  it('opens Reference in the tree on Protocols', () => {
    const html = page(PATHS.protocols);
    const at = html.indexOf('aria-label="Docs"');
    expect(html.slice(at)).toMatch(
      /<details class="navg" open="">(?:(?!<\/details>).)*API reference/s,
    );
  });
});
