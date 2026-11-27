import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunFile, RunIndex } from '../src/web/workbench/console/types.ts';
import { MOVED } from '../src/shared/developers.ts';
import { buildDevelopers, type Manifest } from './build-developers.ts';

const work = mkdtempSync(join(tmpdir(), 'developers-run-'));
let manifest: Manifest;
const read = (file: string) => readFileSync(join(work, file), 'utf8');
const runFile = (slug: string) => JSON.parse(read(`developers/run/${slug}.json`)) as RunFile;

beforeAll(async () => {
  mkdirSync(work, { recursive: true });
  manifest = (await buildDevelopers({ out: work, head: '', origin: 'https://passbook.mobile' }))
    .manifest;
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const opIds = () =>
  new Set(
    readdirSync(join(work, 'developers/run'))
      .filter((f) => f !== 'index.json')
      .flatMap((f) => runFile(f.replace('.json', '')).ops.map((o) => o.id)),
  );
const RUN_LINK = /<a class="btn" href="\/workbench\/console\?op=([^"&]+)">Run in Workbench/g;

describe('what the Workbench Console reads', () => {
  it('links every operation page to Run in Workbench, and every link resolves to a run file operation', () => {
    const dir = join(work, 'developers/reference');
    const pages = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.html'),
    );
    expect(pages.length).toBeGreaterThan(10);
    const known = opIds();
    const linked = new Set<string>();
    for (const page of pages) {
      const html = read(`developers/reference/${page}`);
      expect(html, page).not.toContain('data-island="run"');
      for (const m of html.matchAll(RUN_LINK)) {
        const id = decodeURIComponent(m[1] as string);
        linked.add(id);
        expect(known.has(id), `${page}: ${id}`).toBe(true);
      }
    }
    expect(linked.size).toBeGreaterThan(100);
  });

  it('lists the run files in the manifest as JSON, and keeps them out of the sitemap', () => {
    expect(manifest['/developers/run/index.json']).toEqual({
      asset: '/developers/run/index.json',
      type: 'application/json; charset=utf-8',
    });
    expect(manifest['/developers/run/passes.json']?.asset).toBe('/developers/run/passes.json');
    expect(read('developers/sitemap.xml')).not.toContain('/run/');
  });

  it('indexes every runnable operation once and carries the catalog codes', () => {
    const index = JSON.parse(read('developers/run/index.json')) as RunIndex;
    const ids = index.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    const inFiles = readdirSync(join(work, 'developers/run'))
      .filter((f) => f !== 'index.json')
      .flatMap((f) => runFile(f.replace('.json', '')).ops.map((o) => o.id));
    expect(ids.sort()).toEqual(inFiles.sort());
  });

  it('describes a create call the console can validate and run', () => {
    const create = runFile('passes').ops.find((o) => o.id === 'passes.postPasses');
    expect(create).toMatchObject({
      method: 'post',
      path: '/api/v1/passes',
      idempotent: true,
      destructive: false,
    });
    expect(create?.body?.required).toEqual(expect.arrayContaining(['templateId', 'input']));
    expect(create?.body?.properties?.holderEmail?.maxLength).toBe(254);
    expect(JSON.stringify(create)).not.toContain('$ref');
  });

  it('marks DELETE and void calls as destructive, and an If-Match call asks for the header', () => {
    const ops = runFile('passes').ops;
    expect(
      ops
        .filter((o) => o.destructive)
        .every((o) => o.method === 'delete' || /void|remove|delete/i.test(o.path + o.anchor)),
    ).toBe(true);
    expect(ops.some((o) => o.destructive)).toBe(true);
    const patch = ops.find((o) => o.id === 'passes.patchPassesById');
    expect(patch?.params.some((p) => p.name === 'If-Match' && p.where === 'header')).toBe(true);
  });

  it('holds nothing secret: no key, token or cookie in any run file', () => {
    for (const f of readdirSync(join(work, 'developers/run')))
      expect(read(`developers/run/${f}`)).not.toMatch(/pbtry_|pbp_|pb_(live|test)_|__Host-/);
  });

  it('draws the run link as a ticket with a stub and a body, the id in ?op= and no body in the URL', () => {
    const html = read('developers/reference/passes/create.html');
    expect(html).toMatch(
      /<div class="ticket"><div class="stub">.*?<\/div><div class="body"><div class="try-foot"><a class="btn" href="\/workbench\/console\?op=passes\.postPasses">Run in Workbench/s,
    );
    expect(html).not.toMatch(/\/workbench\/console\?[^"]*body=/i);
  });

  it('keeps no Console page: the old address is a redirect into the Workbench', () => {
    expect(MOVED['/developers/console']).toBe('/workbench/console');
    expect(existsSync(join(work, 'developers/console.html'))).toBe(false);
    expect(manifest['/developers/console']).toBeUndefined();
  });
});
