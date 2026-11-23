import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangelogView } from '../pages/changelog.tsx';
import { Footer } from '../pages/layout.tsx';
import { atomFeed, buildChangelog } from './changelog.ts';
import { loadInputs } from './load.ts';
import { buildSite } from './site.ts';

const root = resolve(import.meta.dirname, '../../../..');
const site = buildSite(loadInputs(root));
const ORIGIN = 'https://passbook.mobile';

describe('changelog model', () => {
  it('orders files newest first and gives an entry its resource, or General', () => {
    const list = buildChangelog(
      [
        { date: '2026-11-01', entries: [{ kind: 'Added', text: 'old' }] },
        {
          date: '2026-11-20',
          entries: [
            { kind: 'Changed', text: 'one', ops: ['a.x'] },
            { kind: 'Changed', text: 'many', ops: ['a.x', 'b.y'] },
          ],
        },
      ],
      new Map([
        ['a.x', 'Passes'],
        ['b.y', 'Templates'],
      ]),
    );
    expect(list.map((e) => [e.date, e.area])).toEqual([
      ['2026-11-20', 'Passes'],
      ['2026-11-20', 'General'],
      ['2026-11-01', 'General'],
    ]);
  });

  it('carries the backfill, the D12 change and the first version', () => {
    expect(site.changelog.length).toBeGreaterThan(10);
    const d12 = site.changelog.find((e) => e.breaking);
    expect(d12?.version).toBe('2026-11-20');
    expect(site.versions[0]?.date).toBe('2026-11-22');
    expect(site.version).toBe('2026-11-22');
  });

  it('badges the operation a changelog entry names', () => {
    const rollCalls = site.pages
      .flatMap((p) => p.ops)
      .find((o) => o.operationId === 'roll-calls.postRollCalls');
    expect(rollCalls?.changedIn).toEqual({ date: '2026-11-20', kind: 'Changed', breaking: true });
  });
});

describe('Atom feed', () => {
  const xml = new DOMParser().parseFromString(atomFeed(site, ORIGIN), 'application/xml');
  const text = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent ?? '';

  it('is well-formed with the required Atom elements', () => {
    expect(xml.getElementsByTagName('parsererror')).toHaveLength(0);
    const feed = xml.documentElement;
    expect(feed.localName).toBe('feed');
    expect(feed.namespaceURI).toBe('http://www.w3.org/2005/Atom');
    for (const tag of ['title', 'id', 'updated', 'author']) expect(text(feed, tag)).not.toBe('');
    expect(text(feed, 'updated')).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
  });

  it('has one entry per change, each with a unique id, a title, a date and content', () => {
    const entries = [...xml.getElementsByTagName('entry')];
    expect(entries).toHaveLength(site.changelog.length);
    const ids = entries.map((e) => text(e, 'id'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of entries) {
      expect(text(e, 'title')).not.toBe('');
      expect(text(e, 'updated')).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
      expect(text(e, 'content')).not.toBe('');
    }
  });

  it('escapes markup in a title', () => {
    const odd = {
      ...site,
      changelog: [{ ...(site.changelog[0] as object), text: 'a <b> & "c"' }],
    } as typeof site;
    const doc = new DOMParser().parseFromString(atomFeed(odd, ORIGIN), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.getElementsByTagName('title')[1]?.textContent).toBe('a <b> & "c"');
  });
});

describe('changelog page', () => {
  const html = renderToStaticMarkup(<ChangelogView site={site} />);
  it('has kind filters, an area filter, version notes and the feed link', () => {
    for (const k of ['All', 'Added', 'Changed', 'Fixed', 'Breaking'])
      expect(html).toContain(`id="k-${k}"`);
    expect(html).toContain('data-area-filter');
    expect(html).toContain('PassBook-Version: 2026-11-20');
    expect(html).toContain('href="/developers/changelog.atom"');
    expect(html).toContain('data-breaking="1"');
  });
  it('shows the version in the footer chip', () => {
    expect(renderToStaticMarkup(<Footer site={site} />)).toContain('#version-2026-11-22');
  });
});
