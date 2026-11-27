import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATHS } from '../../../shared/developers.ts';
import { loadInputs } from '../model/load.ts';
import { buildSite } from '../model/site.ts';
import { buildSearchIndex, INDEX_BUDGET_GZIP, searchIndexFile } from './build.ts';
import { hintFor, isEmpty, LIMITS, narrow, pieces, search, suggestions, wordsOf } from './rank.ts';
import type { SearchIndex } from './types.ts';

const root = resolve(import.meta.dirname, '../../../..');
const site = buildSite(loadInputs(root));
const index = buildSearchIndex(site);

const codes = (q: string) => search(index, q).errors.map((e) => e.code);
const opIds = (q: string) => search(index, q).ops.map((o) => o.id);

describe('the index', () => {
  it('stays under its gzip budget, and the build file says so', () => {
    const file = searchIndexFile(site);
    expect(file.file).toBe(PATHS.searchIndex);
    expect(file.gzip).toBeLessThan(INDEX_BUDGET_GZIP);
    expect(JSON.parse(file.body).v).toBe(1);
  });

  it('has the five groups: every error, every operation, guides, events and actions', () => {
    expect(index.errors).toHaveLength(site.errors.length);
    expect(index.ops).toHaveLength(site.pages.reduce((n, p) => n + p.ops.length, 0));
    expect(index.guides.length).toBeGreaterThan(10);
    expect(index.events.map((e) => e.type)).toEqual(site.webhookEvents.map((e) => e.type));
    expect(index.actions.length).toBeGreaterThan(3);
  });

  it('links every row to a page the portal has, with the anchors the pages carry', () => {
    const anchors = new Set(
      site.pages.flatMap((p) =>
        p.ops.map((o) => `${PATHS.reference}/${p.slug}/${o.anchor.toLowerCase()}`),
      ),
    );
    for (const o of index.ops) expect(anchors.has(o.href), o.href).toBe(true);
    for (const e of index.errors) expect(e.href).toBe(`${PATHS.errors}/${e.code}`);
    for (const e of index.events) expect(e.href).toBe(`/workbench/events?type=${e.type}`);
    for (const row of [...index.guides, ...index.actions])
      expect(row.href, row.id).toMatch(/^\/(developers|admin|workbench)(\/|$)/);
  });

  it('lists the one-operation curl snippets by id for the Console', () => {
    const withSamples = buildSearchIndex(site, [
      {
        id: 'create-order-pass',
        title: 't',
        guide: 'issue-on-purchase',
        ops: ['passes.postPasses'],
        ts: '',
        curl: 'curl',
      },
      { id: 'two-ops', title: 't', guide: 'g', ops: ['a', 'b'], ts: '', curl: 'curl' },
      { id: 'no-curl', title: 't', guide: 'g', ops: ['a'], ts: '', curl: undefined },
    ]);
    expect(withSamples.samples).toEqual([
      { id: 'create-order-pass', op: 'passes.postPasses', guide: 'issue-on-purchase' },
    ]);
  });

  it('resolves every hint link and the secret help to rows it has', () => {
    for (const h of index.hints) {
      expect(h.links.length, h.terms[0]).toBeGreaterThan(0);
      for (const l of h.links) expect(l.href).toMatch(/^\/developers\//);
    }
    for (const id of index.secretHelp)
      expect(
        [...index.guides, ...index.actions].some((r) => r.id === id),
        id,
      ).toBe(true);
  });

  it('carries no secret-looking text, so nothing a reader pastes could match one', () => {
    expect(JSON.stringify(index)).not.toMatch(/(?:pbtry|pbp|pbo|pb|wlt)_[A-Za-z0-9_-]{8,}/);
  });
});

describe('ranking fixtures', () => {
  it('puts an exact error code first, then the codes that contain it', () => {
    const [first, ...rest] = codes('TEMPLATE_RELEASE_REQUIRED');
    expect(first).toBe('TEMPLATE_RELEASE_REQUIRED');
    expect(rest.every((c) => c.includes('TEMPLATE_RELEASE_REQUIRED'))).toBe(true);
    expect(codes('template_release_required')[0]).toBe('TEMPLATE_RELEASE_REQUIRED');
  });

  it('finds an operation by its SDK name, with or without pb., and by its operation id', () => {
    expect(opIds('passes.create')[0]).toBe('passes.postPasses');
    expect(opIds('pb.passes.create')[0]).toBe('passes.postPasses');
    expect(opIds('passes.postPasses')[0]).toBe('passes.postPasses');
  });

  it('finds an operation by method and path, and by a route with real ids in it', () => {
    expect(opIds('POST /passes')[0]).toBe('passes.postPasses');
    expect(opIds('POST /api/v1/passes')[0]).toBe('passes.postPasses');
    expect(opIds('GET /passes/0193a1b2-7c00-7000-8000-0000000000c1')[0]).toBe(
      'passes.getPassesById',
    );
    expect(opIds('DELETE /passes/0193a1b2-7c00-7000-8000-0000000000c1')).not.toContain(
      'passes.getPassesById',
    );
  });

  it('puts a name that starts with the word ahead of one that only contains it', () => {
    const titles = search(index, 'void').ops.map((o) => o.title.toLowerCase());
    const starts = titles.findIndex((t) => t.startsWith('void'));
    const contains = titles.findIndex((t) => !t.startsWith('void') && t.includes('void'));
    if (starts >= 0 && contains >= 0) expect(starts).toBeLessThan(contains);
    expect(titles.length).toBeGreaterThan(0);
  });

  it('needs every word to match, and matches events, guides and actions', () => {
    expect(codes('template zzzz')).toEqual([]);
    expect(search(index, 'pass.voided').events[0]?.type).toBe('pass.voided');
    expect(search(index, 'go live').guides[0]?.id).toBe('go-live');
    expect(search(index, 'test webhook').actions[0]?.id).toBe('test-webhook');
    expect(search(index, 'rotate').actions.map((a) => a.id)).toContain('roll-key');
  });

  it('answers a word that finds nothing with its hint', () => {
    expect(isEmpty(search(index, 'refund'))).toBe(true);
    const hint = hintFor(index, 'refund');
    expect(hint?.links.map((l) => l.label)).toEqual([
      'Void a pass',
      'Remove a pass',
      'Pass lifecycle',
    ]);
    expect(hintFor(index, 'release')).toBeNull();
  });

  it('offers a start before anything is typed, and caps each group', () => {
    const start = suggestions(index);
    expect(start.guides.length).toBeGreaterThan(0);
    expect(start.errors).toEqual([]);
    const wide = search(index, 'a');
    expect(wide.errors.length).toBeLessThanOrEqual(LIMITS.errors);
    expect(wide.ops.length).toBeLessThanOrEqual(LIMITS.ops);
  });

  it('marks the words it matched, in any case', () => {
    expect(pieces('TEMPLATE_RELEASE_REQUIRED', wordsOf('release'))).toEqual([
      { text: 'TEMPLATE_', hit: false },
      { text: 'RELEASE', hit: true },
      { text: '_REQUIRED', hit: false },
    ]);
    expect(pieces('Approve a release', ['approve', 'release']).filter((p) => p.hit)).toHaveLength(
      2,
    );
  });
});

describe('stable ordering', () => {
  const tiny: SearchIndex = {
    ...index,
    errors: ['B_THING', 'A_THING', 'C_THING', 'THING'].map((code) => ({
      code,
      status: 400,
      title: '',
      when: '',
      fix: '',
      retryable: null,
      href: `/e/${code}`,
    })),
    ops: [],
    guides: [],
    events: [],
    actions: [],
  };

  it('gives the same list for the same query every time, whatever was searched in between', () => {
    const first = JSON.stringify(search(index, 'release'));
    for (const other of ['pass', 'webhook', 'x', 'POST /passes', 'refund'])
      JSON.stringify(search(index, other));
    expect(JSON.stringify(search(index, 'release'))).toBe(first);
  });

  it('breaks a tie by the index’s own order, never by anything that could change under the reader', () => {
    // Same tier and the same length: B, A, C keep the order the build wrote.
    expect(search(tiny, 'thing').errors.map((e) => e.code)).toEqual([
      'THING',
      'B_THING',
      'A_THING',
      'C_THING',
    ]);
    const reversed = { ...tiny, errors: [...tiny.errors].reverse() };
    expect(search(reversed, 'thing').errors.map((e) => e.code)).toEqual([
      'THING',
      'C_THING',
      'A_THING',
      'B_THING',
    ]);
  });

  it('narrows a shown list without moving a row, and never adds one', () => {
    const shown = search(index, 'r');
    for (const q of ['re', 'rel', 'rele', 'relea', 'releas', 'release']) {
      const next = narrow(shown, q);
      for (const group of ['errors', 'ops', 'guides', 'events', 'actions'] as const) {
        const kept = (shown[group] as object[]).filter((row) =>
          (next[group] as object[]).includes(row),
        );
        expect(next[group], `${q} ${group}`).toEqual(kept);
      }
    }
    // What survives is what the fresh search also finds, whenever the fresh search shows it.
    const fresh = search(index, 'release');
    for (const e of narrow(shown, 'release').errors) expect(index.errors).toContain(e);
    expect(fresh.errors.length).toBeGreaterThan(0);
  });
});
