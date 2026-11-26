import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunFile, RunIndex } from '../src/web/developers/console/types.ts';
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

describe('what the Run island reads', () => {
  it('has a slot on every operation, and every slot resolves to its operation in its page file', () => {
    const dir = join(work, 'developers/reference');
    const pages = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.html'),
    );
    expect(pages.length).toBeGreaterThan(10);
    let slots = 0;
    for (const page of pages) {
      const html = read(`developers/reference/${page}`);
      for (const m of html.matchAll(/data-island="run" data-op="([^"]+)" data-slug="([^"]+)"/g)) {
        slots += 1;
        const file = runFile(m[2] as string);
        expect(
          file.ops.some((o) => o.id === m[1]),
          `${page}: ${m[1]}`,
        ).toBe(true);
      }
    }
    expect(slots).toBeGreaterThan(100);
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

  it('draws the slot as a ticket with a stub and a body, the shape the island keeps', () => {
    expect(read('developers/reference/passes/create.html')).toMatch(
      /data-island="run"[^>]*><div class="ticket"><div class="stub">.*?<\/div><div class="body">/s,
    );
  });

  it('draws the console slot as the signed-out Gate until the island takes over', () => {
    const html = read('developers/console.html');
    expect(html).toMatch(/data-island="console"[^>]*><section class="card gate" data-gate=""/);
  });
});
