import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATHS } from '../../shared/developers.ts';
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

  it('marks the console in the nav and offers sign-in in place of an empty panel', () => {
    const html = body(`${PATHS.console}.html`);
    expect(html).toMatch(/<a href="\/developers\/console" aria-current="page">Console<\/a>/);
    expect(html).toContain('Sign in to try');
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
});
