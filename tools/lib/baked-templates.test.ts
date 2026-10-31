import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicPackage, makePng } from '../../src/worker/modules/templates/package/fixtures.ts';
import { bakedBuildHash, collectBaked, renderBakedModule } from './baked-templates.ts';

let dir: string;
const templatesDir = () => join(dir, 'templates');
const publicDir = () => join(dir, 'public');

function writePackage(slug: string, files: Map<string, Uint8Array>): void {
  for (const [name, bytes] of files) {
    const file = join(templatesDir(), slug, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baked-'));
  mkdirSync(templatesDir(), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('collectBaked', () => {
  it('indexes packages, copies bundle files to a versioned static path and skips _ folders', async () => {
    writePackage('starter-generic', basicPackage());
    writePackage('_scratch', basicPackage());
    const baked = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    expect(baked.map((t) => t.id)).toEqual(['baked:starter-generic']);
    const [t] = baked;
    expect(t?.org).toBeNull();
    expect(t?.assets.map((a) => a.name)).toEqual(['icon.png', 'icon@2x.png']);
    expect(t?.assets[0]?.source).toEqual({
      kind: 'static',
      path: `/templates/starter-generic/${t?.version}/icon.png`,
    });
    const copied = join(
      publicDir(),
      'templates',
      'starter-generic',
      t?.version ?? '',
      'icon@2x.png',
    );
    expect(readFileSync(copied).length).toBe(t?.assets[1]?.size);
    expect(existsSync(join(publicDir(), 'templates', '_scratch'))).toBe(false);
    expect(
      existsSync(join(publicDir(), 'templates', 'starter-generic', t?.version ?? '', 'pass.json')),
    ).toBe(false);
  });

  it('generates a default manifest when wallet.template.json is absent and keeps one when present', async () => {
    writePackage('plain', basicPackage());
    const manifest = JSON.stringify({
      schema: 1,
      name: 'Henry',
      description: 'Gym card',
      org: { slug: 'henrys', name: "Henry's Gymnasium" },
      inputs: { type: 'object', properties: { name: { type: 'string', pattern: '^[A-Z]' } } },
      sample: { name: 'Alex' },
      bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
      display: { title: '{{name}}' },
    });
    writePackage('custom', basicPackage({ 'wallet.template.json': manifest }));
    const baked = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    const plain = baked.find((t) => t.slug === 'plain');
    const custom = baked.find((t) => t.slug === 'custom');
    expect(plain?.name).toBe('plain');
    expect(plain?.manifest.sample).toEqual({ name: 'Alex Morgan' });
    expect(custom).toMatchObject({
      name: 'Henry',
      description: 'Gym card',
      org: { slug: 'henrys', name: "Henry's Gymnasium" },
    });
  });

  it('is deterministic and the version follows content', async () => {
    writePackage('a', basicPackage());
    writePackage('b', basicPackage({ 'logo.png': makePng(160, 50) }));
    const one = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    const two = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    expect(renderBakedModule(one, '// h\n')).toBe(renderBakedModule(two, '// h\n'));
    expect(one[0]?.version).not.toBe(one[1]?.version);
    expect(bakedBuildHash(one)).toBe(bakedBuildHash(two));
    writePackage('a', basicPackage({ 'logo.png': makePng(100, 40) }));
    const three = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    expect(bakedBuildHash(three)).not.toBe(bakedBuildHash(one));
  });

  it('keeps unused-slot files as static extras outside the bundle', async () => {
    writePackage('t', basicPackage({ 'strip.png': makePng(375, 144) }));
    const [t] = await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    expect(t?.assets.map((a) => a.name)).not.toContain('strip.png');
    expect(t?.extras.map((e) => e.name)).toEqual(['strip.png']);
    expect(existsSync(join(publicDir(), 'templates', 't', t?.version ?? '', 'strip.png'))).toBe(
      true,
    );
  });

  it('removes stale static output', async () => {
    mkdirSync(join(publicDir(), 'templates', 'gone', 'v1'), { recursive: true });
    writeFileSync(join(publicDir(), 'templates', 'gone', 'v1', 'x.png'), 'x');
    await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() });
    expect(existsSync(join(publicDir(), 'templates', 'gone'))).toBe(false);
  });

  it('fails the build on an invalid package', async () => {
    writePackage('bad', basicPackage({ 'icon@2x.png': makePng(10, 10) }));
    await expect(
      collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() }),
    ).rejects.toThrow(/templates\/bad: error IMAGE_SIZE/);
    writePackage('worse', new Map([['icon.png', makePng(38, 38)]]));
    await expect(
      collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() }),
    ).rejects.toThrow(/PASS_JSON_MISSING/);
  });

  it('handles an empty or missing templates directory', async () => {
    rmSync(templatesDir(), { recursive: true });
    expect(await collectBaked({ templatesDir: templatesDir(), publicDir: publicDir() })).toEqual(
      [],
    );
  });
});
