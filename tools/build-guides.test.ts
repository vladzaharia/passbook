import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_GUIDES } from '../src/shared/copy/developers.ts';
import { buildDevelopers, type Manifest } from './build-developers.ts';

const work = mkdtempSync(join(tmpdir(), 'developers-guides-'));
let manifest: Manifest;
const read = (file: string) => readFileSync(join(work, file), 'utf8');
const page = (id: string) => read(`developers/guides/${id}.html`);
/** The Copy for AI text: the attribute is HTML-escaped. */
const copyText = (html: string) =>
  (/data-copy-text="([^"]*)"/.exec(html)?.[1] ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

beforeAll(async () => {
  mkdirSync(work, { recursive: true });
  manifest = (await buildDevelopers({ out: work, head: '', origin: 'https://passbook.mobile' }))
    .manifest;
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('guide pages', () => {
  it('serves an index, a page and a markdown twin per guide', () => {
    expect(manifest['/developers/guides']).toBeDefined();
    for (const g of DEV_GUIDES) {
      expect(manifest[`/developers/guides/${g.id}`], g.id).toBeDefined();
      expect(manifest[`/developers/guides/${g.id}.md`]?.type, g.id).toContain('text/markdown');
      expect(read('developers/guides/index.html')).toContain(`href="/developers/guides/${g.id}"`);
    }
  });

  it('groups the index by step and names the step above each guide', () => {
    const index = read('developers/guides/index.html');
    const heads = [...index.matchAll(/<h2 id="step-[a-z]+" class="h3 gsec-h">([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(heads).toEqual(['Start', 'Issue', 'Change', 'At the door', 'Connect', 'Launch']);
    expect(page('go-live')).toMatch(/class="gkicker green">Launch</);
    expect(read('developers/guides.md')).toContain('## At the door');
  });

  it('opens the Workbench Console on the operation from every runnable guide', () => {
    for (const g of DEV_GUIDES.filter((d) => d.id !== 'partner-apps')) {
      const links = [...page(g.id).matchAll(/href="(\/workbench\/console\?op=[^"]+)"/g)];
      expect(links.length, g.id).toBeGreaterThan(0);
    }
    expect(page('issue-on-purchase')).toContain(
      '/workbench/console?op=passes.postPasses&amp;sample=',
    );
    expect(page('issue-on-purchase')).not.toMatch(/href="\/workbench[^"]*body=/);
  });

  it('copies the guide and its operation list for AI', () => {
    for (const g of DEV_GUIDES) {
      const html = page(g.id);
      expect(html, g.id).toContain('Copy for AI');
      const md = copyText(html);
      expect(md, g.id).toContain(`# ${g.title}`);
      expect(md.trimEnd(), g.id).toBe(read(`developers/guides/${g.id}.md`).trimEnd());
    }
    const md = copyText(page('update-a-pass'));
    expect(md).toContain('## Operations');
    expect(md).toContain('PATCH /api/v1/passes/{id}');
    expect(md).toContain('```sh');
    expect(md).not.toContain('console:');
    expect(md).not.toMatch(/\]\(\/developers/);
  });

  it('labels NFC a preview and ends every sandbox guide at a result', () => {
    expect(page('nfc')).toContain('>Preview<');
    for (const g of DEV_GUIDES.filter((d) => d.id !== 'partner-apps'))
      expect(read(`developers/guides/${g.id}.md`), g.id).toMatch(/## Result\n[\s\S]+$/);
  });

  it('draws the lifecycle as an accessible SVG with the table beside it', () => {
    const html = page('pass-lifecycle');
    expect(html).toMatch(
      /<svg class="lifecycle"[^>]*role="img"[^>]*aria-labelledby="lc-title lc-desc"/,
    );
    expect(html).toContain('<title id="lc-title">Pass lifecycle</title>');
    for (const call of ['void', 'unvoid', 'remove', 'restore', 'DELETE'])
      expect(html, call).toContain(`>${call}<`);
    expect(read('developers/guides/pass-lifecycle.md')).toContain('stateDiagram-v2');
  });

  it('links the guides from the sitemap and llms.txt-visible pages without inline script or style', () => {
    expect(read('developers/sitemap.xml')).toContain('/developers/guides/go-live');
    for (const g of DEV_GUIDES) {
      expect(page(g.id), g.id).not.toMatch(/<script(?![^>]*\ssrc=)|<style|\sstyle="/);
    }
  });
});
