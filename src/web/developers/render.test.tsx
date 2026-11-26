import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATHS } from '../../shared/developers.ts';
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

  it('lights the section a page belongs to: Workbench for tools, Playground for itself, nothing for the console-less pages', () => {
    const bar = (file: string) => {
      const html = body(file);
      return html.slice(html.indexOf('aria-label="Sections"'), html.indexOf('</nav>'));
    };
    const lit = (file: string) =>
      [...bar(file).matchAll(/aria-current="page"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect([...bar(`${PATHS.console}.html`).matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual([
      'Quickstart',
      'Guides',
      'Reference',
      'Playground',
      'Workbench',
    ]);
    expect(lit(`${PATHS.console}.html`)).toEqual(['Workbench']);
    for (const p of [PATHS.keys, PATHS.logs, PATHS.webhooks])
      expect(lit(`${p}.html`), p).toEqual(['Workbench']);
    expect(lit(`${PATHS.playground}.html`)).toEqual(['Playground']);
    expect(lit(`${PATHS.errors}/index.html`).concat(lit(`${PATHS.protocols}.html`))).toEqual([
      'Reference',
      'Reference',
    ]);
    expect(lit(`${PATHS.changelog}.html`)).toEqual([]);
    expect(body(`${PATHS.console}.html`)).toContain('Run any call against your sandbox.');
  });

  it('frames the four tools as one bench: one h1, Skip to tool, the strip, no sandbox chip in the bar', () => {
    for (const [path, label] of [
      [PATHS.console, 'Console'],
      [PATHS.webhooks, 'Webhooks'],
      [PATHS.logs, 'Logs'],
      [PATHS.keys, 'Keys'],
    ] as const) {
      const html = page(path);
      expect(html.match(/<h1\b[^>]*>[^<]*<\/h1>/g), path).toEqual([`<h1 class="h1">${label}</h1>`]);
      expect(html, path).toContain(`<title>${label} · Developers · PassBook</title>`);
      expect(html, path).toContain(
        '<a class="skip" href="#main">Skip to content</a><a class="skip" href="#tool">Skip to tool</a>',
      );
      expect(html, path).toContain('data-island="bench-strip"');
      expect(html, path).not.toContain('data-island="org-chip"');
      expect(html, path).toContain(
        '<script async blocking="render" src="/developers/bench-vt.js">',
      );
    }
    // Docs pages keep the chip in the bar and run no tool switch.
    expect(page(PATHS.quickstart)).toContain('data-island="org-chip"');
    expect(page(PATHS.quickstart)).not.toContain('bench-vt.js');
    expect(body('/developers/bench-vt.js')).toContain("addEventListener('pagereveal'");
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
    expect(tree(PATHS.quickstart)).toContain(`<a href="${PATHS.quickstart}" aria-current="page"`);
    expect(tree(PATHS.changelog)).toContain(`<a href="${PATHS.changelog}" aria-current="page"`);
    // The Workbench group is in every tree, the sheet's too.
    for (const url of [PATHS.home, PATHS.keys, PATHS.console, PATHS.guides, PATHS.playground])
      expect(tree(url), url).toContain('>Webhooks<');
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
    expect(page(PATHS.quickstart)).not.toContain('aria-label="Breadcrumb"');
  });

  it('prerenders the playground with a sample pass and its fields when the previews are known', () => {
    const withSample = renderSite(site, ORIGIN, '', undefined, {
      schema: 1,
      items: [
        {
          id: 'baked:starter-store-card',
          slug: 'starter-store-card',
          name: 'Balance card',
          description: null,
          inputs: { properties: { balance: { 'x-label': 'Balance' } } },
          sample: { balance: 25 },
          manifest: {},
          passJson: {},
          assetBaseUrl: '',
          assetNames: [],
          assets: [],
          paper: { src: '/developers/paper/starter-store-card.svg', width: 520, height: 300 },
        },
      ],
    });
    const html = withSample.find((f) => f.url === PATHS.playground)?.body ?? '';
    expect(html).toContain('/developers/paper/starter-store-card.svg');
    expect(html).toMatch(/<dt>Balance<\/dt><dd>25<\/dd>/);
  });

  it('has the console, logs, status, playground and changelog pages and the feed', () => {
    const urls = files.map((f) => f.url).filter(Boolean);
    for (const path of [PATHS.console, PATHS.logs, PATHS.status, PATHS.playground, PATHS.changelog])
      expect(urls, path).toContain(path);
    expect(files.some((f) => f.file === PATHS.changelogFeed)).toBe(true);
    expect(body(PATHS.changelogFeed)).toContain('<feed');
    expect(body(PATHS.logsOps)).toContain('passes.');
  });

  it('writes the run files the Try it island reads, one per page and an index', () => {
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
    expect(chip(PATHS.keys, 'Workbench')).toBe('true');
    expect(chip(PATHS.keys, 'Guides')).toBeUndefined();
  });

  it('opens Reference in the tree on Protocols', () => {
    const html = page(PATHS.protocols);
    const at = html.indexOf('aria-label="Docs"');
    expect(html.slice(at)).toMatch(
      /<details class="navg" open="">(?:(?!<\/details>).)*API reference/s,
    );
  });
});
