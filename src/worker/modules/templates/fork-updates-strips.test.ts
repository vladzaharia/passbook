/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
import { renderStampFiles } from '../../../passkit/stamps/package.ts';
import type { AssetEntry } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import type { BakedAsset, BakedTemplate } from './baked-types.ts';
import { type ForkKit, forkKit } from './fork-updates-test-fixtures.ts';
import { imagesFromBinding } from './images-binding.ts';
import { makePng } from './package/fixtures.ts';
import { contentVersion, crc32, sha1Hex } from './package/hash.ts';
import { bakedR2Key, generatedSource } from './sync.ts';
import { checkVersion } from './version-check.ts';

const SLUG = 'starter-stamp-card';
let k: ForkKit;
let v2: BakedTemplate;
const served = () => (k.kit.env.ASSETS as unknown as { files: Map<string, Uint8Array> }).files;

/** The Stamp card with new filled-stamp art: the stamp key changes, so every strip is drawn again. */
async function recolored(tpl: BakedTemplate): Promise<BakedTemplate> {
  const art = (name: string) => tpl.assets.find((a) => a.name === name) as BakedAsset;
  const filled = art('stamps/filled.png');
  const inputs: Record<string, Uint8Array> = {};
  for (const a of tpl.assets)
    if (a.stamps === undefined) inputs[a.name] = served().get(a.source.path) as Uint8Array;
  inputs['stamps/filled.png'] = makePng(filled.width ?? 1, filled.height ?? 1);
  const block = tpl.manifest.stamps;
  if (!block) throw new Error('no stamps block');
  const drawn = new Map(renderStampFiles(block, inputs).strips.map((s) => [s.name, s.bytes]));
  const assets: BakedAsset[] = [];
  for (const a of tpl.assets) {
    const bytes = a.name === 'stamps/filled.png' ? inputs[a.name] : drawn.get(a.name);
    if (!bytes) {
      assets.push(a);
      continue;
    }
    const path = `/templates/${SLUG}/recolored/${a.name}`;
    served().set(path, bytes);
    assets.push({
      ...a,
      size: bytes.length,
      sha1: await sha1Hex(bytes),
      crc32: crc32(bytes),
      source: { kind: 'static', path },
    });
  }
  const version = await contentVersion({ passJson: tpl.passJson, manifest: tpl.manifest, assets });
  return { ...tpl, version, assets };
}

beforeAll(async () => {
  k = await forkKit();
});

describe('stamp strips of an upstream', () => {
  it('are reused by a fork job, and copied under the fork', async () => {
    const tpl = generatedSource.templates.find((t) => t.slug === SLUG) as BakedTemplate;
    const id = await k.fork(SLUG, 'Stamp copy');
    v2 = await recolored(tpl);
    await k.sync([v2]);
    const reads: string[] = [];
    const env = {
      ...k.kit.env,
      BUCKET: new Proxy(k.kit.env.BUCKET, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'get') return typeof value === 'function' ? value.bind(target) : value;
          return (key: string, ...rest: unknown[]) => {
            reads.push(key);
            return (target.get as (...a: unknown[]) => unknown)(key, ...rest);
          };
        },
      }),
    };
    await k.tick(env as never);
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    const stored = await first<{ assets: string }>(
      k.kit.env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [id, row?.merged_version],
    );
    const strips = (JSON.parse(stored?.assets ?? '[]') as AssetEntry[]).filter(
      (a) => a.stamps !== undefined,
    );
    const upstream = v2.assets.filter((a) => a.stamps !== undefined);
    expect(strips.length).toBe(upstream.length);
    for (const a of strips) {
      expect(a.source).toMatchObject({ kind: 'r2' });
      expect((a.source as { key: string }).key.startsWith(`templates/${k.kit.org.id}/${id}/`)).toBe(
        true,
      );
      const same = upstream.find((u) => u.name === a.name);
      expect(a.sha1).toBe(same?.sha1);
    }
    // They were read from the upstream's stored copy, not drawn again.
    const first1 = upstream[0] as BakedAsset;
    expect(reads).toContain(bakedR2Key(SLUG, v2.version, first1.name));
  });

  it('are never read from another org’s built-in', async () => {
    const other: BakedTemplate = {
      ...v2,
      id: 'baked:other-stamps',
      slug: 'other-stamps',
      blueprint: false,
      org: { slug: 'other-stamps-org', name: 'Other org' },
    };
    // A fork made from the original art, before the recolored build is current.
    const tpl = generatedSource.templates.find((t) => t.slug === SLUG) as BakedTemplate;
    await k.sync([tpl]);
    const id = await k.fork(SLUG, 'Stamp copy 2');
    await k.sync([v2, other]);
    const reads: string[] = [];
    const env = {
      ...k.kit.env,
      BUCKET: new Proxy(k.kit.env.BUCKET, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'get') return typeof value === 'function' ? value.bind(target) : value;
          return (key: string, ...rest: unknown[]) => {
            reads.push(key);
            return (target.get as (...a: unknown[]) => unknown)(key, ...rest);
          };
        },
      }),
    };
    const ctx = createJobContext(env as never, 'strips', { clock: k.kit.clock });
    const { blueprint: _b, ...manifest } = v2.manifest as unknown as Record<string, unknown>;
    const body = {
      passJson: v2.passJson,
      manifest: manifest as never,
      assets: v2.assets
        .filter((a) => a.stamps === undefined)
        .map((a) => ({ name: a.name, sha1: a.sha1 })),
    };
    // The recolored art exists only in the other org's built-in: it supplies neither files nor strips.
    await expect(
      checkVersion(
        ctx,
        { id, name: 'Stamp copy 2' },
        k.kit.org.id,
        body,
        imagesFromBinding(undefined, ctx.log),
        { dryRun: false },
        { upstreamId: 'baked:other-stamps' },
      ),
    ).rejects.toMatchObject({ code: 'ASSETS_INVALID' });
    expect(reads.filter((key) => key.includes('other-stamps'))).toEqual([]);
  });
});
