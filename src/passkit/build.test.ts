import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPass, PassBuildError } from './build.ts';
import { packagePassBytes } from './package/zip.ts';
import { InMemoryTemplateRegistry } from './template/in-memory-registry.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from './testing/fixture-identity.ts';
import type { PassJson, SigningMaterial, TemplateManifest } from './types.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const manifest: TemplateManifest = {
  schema: 1,
  name: 'T',
  inputs: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      club: { type: 'string', enum: ['a', 'b'] },
      url: { type: 'string' },
    },
  },
  sample: { name: 'X' },
  lookups: { clubs: { a: { phone: '111' }, b: { phone: '222' } } },
  bindings: [
    { to: { field: ['name', 'name-back'] }, value: '{{name}}' },
    { to: { field: 'phone' }, value: '{{lookups.clubs[club].phone}}' },
    { to: { field: 'only-a' }, remove: { not: { input: 'club', eq: 'a' } } },
    { to: { barcode: '*', prop: 'message' }, value: '{{name}}' },
    { to: { action: 'site', prop: 'url' }, value: '{{url}}', omitIfEmpty: true },
  ],
  display: { title: '{{name}}' },
};
const passJson = {
  formatVersion: 1,
  passTypeIdentifier: 'x',
  teamIdentifier: 'x',
  serialNumber: 'x',
  organizationName: 'x',
  description: 'd',
  barcodes: [{ format: 'PKBarcodeFormatCode128', message: '', messageEncoding: 'iso-8859-1' }],
  featuredActions: [{ identifier: 'site', type: 'url', url: 'https://old.example.com' }],
  generic: {
    primaryFields: [{ key: 'name', label: 'Name', value: '', _id: 'designer' }],
    backFields: [
      { key: 'name-back', value: '' },
      { key: 'phone', value: '' },
      { key: 'only-a', value: 'a' },
    ],
  },
} as unknown as PassJson;

let material: SigningMaterial;
const registry = new InMemoryTemplateRegistry();
const template = registry.add({ id: 't1', manifest, passJson, assets: { 'icon.png': PNG } });
const server = (material: SigningMaterial) => ({
  serial: 'serial-1',
  authToken: 'a'.repeat(32),
  webServiceURL: 'https://wallet.example/wallet',
  organizationName: 'Org',
  identity: FIXTURE_IDENTITY,
  signing: material,
});

beforeAll(async () => {
  material = await createFixtureIdentity();
});

describe('buildPass', () => {
  it('binds fields, lookups, conditions, barcodes and actions, injects server fields and signs', async () => {
    const built = await buildPass({
      template,
      registry,
      input: { name: 'Alex', club: 'a', url: 'https://x.example.com' },
      server: server(material),
      signing: material,
    });
    const p = built.passJson;
    expect(p.generic?.primaryFields?.[0]).toEqual({ key: 'name', label: 'Name', value: 'Alex' });
    expect(p.generic?.backFields?.map((f) => [f.key, f.value])).toEqual([
      ['name-back', 'Alex'],
      ['phone', '111'],
      ['only-a', 'a'],
    ]);
    expect(p.barcodes?.[0]?.message).toBe('Alex');
    expect(((p.featuredActions ?? [])[0] as { url: string }).url).toBe('https://x.example.com');
    expect(p).toMatchObject({
      serialNumber: 'serial-1',
      authenticationToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: 'Org',
      passTypeIdentifier: FIXTURE_IDENTITY.passTypeIdentifier,
    });
    const files = unzipSync(packagePassBytes(built.signed));
    expect(Object.keys(files)).toContain('signature');
    expect(JSON.parse(new TextDecoder().decode(files['pass.json']))).toEqual(p);
  });

  it('writes every date in whole seconds', async () => {
    const dated = {
      ...passJson,
      expirationDate: '2030-06-01T20:00:04.263Z',
      relevantDates: [{ startDate: '2030-06-01T18:00:00.500Z', endDate: '2030-06-01T21:00:00Z' }],
      semantics: { eventStartDate: '2030-06-01T19:00:00.120-07:00' },
      generic: {
        ...(passJson.generic as object),
        headerFields: [
          { key: 'when', value: '2030-06-01T19:00:00.987Z', ignoresTimeZone: true },
          { key: 'at', value: '2030-06-01T19:00:00.321-07:00' },
        ],
      },
    } as unknown as PassJson;
    const reg = new InMemoryTemplateRegistry();
    const t = reg.add({ id: 't2', manifest, passJson: dated, assets: { 'icon.png': PNG } });
    const built = await buildPass({
      template: t,
      registry: reg,
      input: { name: 'Alex', club: 'a' },
      server: server(material),
      signing: material,
    });
    const files = unzipSync(packagePassBytes(built.signed));
    const text = new TextDecoder().decode(files['pass.json']);
    expect(text).toContain('2030-06-01T19:00:00');
    expect(text).not.toMatch(/\.\d+(Z|[+-])/);
  });

  it('removes conditional fields and omits empty action bindings', async () => {
    const built = await buildPass({
      template,
      registry,
      input: { name: 'Alex', club: 'b', url: '' },
      server: server(material),
      signing: material,
    });
    expect(built.passJson.generic?.backFields?.map((f) => f.key)).toEqual(['name-back', 'phone']);
    expect(built.passJson.featuredActions).toEqual([]);
  });

  it('does not mutate the template pass.json', async () => {
    await buildPass({
      template,
      registry,
      input: { name: 'Alex', club: 'a', url: 'https://x.example.com' },
      server: server(material),
      signing: material,
    });
    expect(template.passJson.generic?.primaryFields?.[0]?.value).toBe('');
  });

  it('rejects invalid input with a report', async () => {
    const error = await buildPass({
      template,
      registry,
      input: { club: 'zzz' },
      server: server(material),
      signing: material,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PassBuildError);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
    expect((error as PassBuildError).report.issues.length).toBeGreaterThan(0);
  });

  it('refuses to sign a pass that fails validation', async () => {
    const bad = registry.add({
      id: 'bad',
      manifest,
      passJson: {
        ...passJson,
        generic: {
          primaryFields: [
            { key: 'dup', value: '1' },
            { key: 'dup', value: '2' },
          ],
        },
      } as PassJson,
      assets: { 'icon.png': PNG },
    });
    const error = await buildPass({
      template: bad,
      registry,
      input: { name: 'A', club: 'a' },
      server: server(material),
      signing: material,
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('INVALID_PASS');
    expect((error as PassBuildError).report.issues.map((i) => i.code)).toContain(
      'DUPLICATE_FIELD_KEY',
    );
  });

  it('fails for an unknown behavior', async () => {
    const t = registry.add({
      id: 'beh',
      manifest: { ...manifest, behaviors: [{ use: 'nope', version: 1, config: {} }] },
      passJson,
      assets: { 'icon.png': PNG },
    });
    const error = await buildPass({
      template: t,
      registry,
      input: { name: 'A', club: 'a', url: '' },
      server: server(material),
      signing: material,
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('BEHAVIOR');
  });

  it('is deterministic for identical input and clock', async () => {
    const now = new Date();
    const run = () =>
      buildPass({
        template,
        registry,
        input: { name: 'Alex', club: 'a', url: 'https://x.example.com' },
        server: server(material),
        signing: material,
        now,
      });
    const [a, b] = [await run(), await run()];
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.signed.manifest).toEqual(b.signed.manifest);
    expect(a.signed.files['pass.json']).toEqual(b.signed.files['pass.json']);
  });

  it('skips signing when unchanged unless forced', async () => {
    const args = {
      template,
      registry,
      input: { name: 'Alex', club: 'a', url: '' },
      server: server(material),
      signing: material,
    };
    const first = await buildPass(args);
    const same = await buildPass({ ...args, previousHash: first.contentHash });
    expect(same.changed).toBe(false);
    expect('signed' in same).toBe(false);
    const forced = await buildPass({ ...args, previousHash: first.contentHash, force: true });
    expect(forced.changed).toBe(true);
    const edited = await buildPass({
      ...args,
      input: { ...args.input, name: 'Blake' },
      previousHash: first.contentHash,
    });
    expect(edited.changed).toBe(true);
  });

  it('leaves preview-only files out and applies per-pass overrides', async () => {
    const icon = pngOf(38, 38);
    const t = registry.add({
      id: 'assets',
      manifest: { ...manifest, previewOnlyAssets: ['background.png'] },
      passJson,
      assets: { 'icon.png': PNG, 'background.png': PNG, 'thumbnail.png': PNG },
    });
    const built = await buildPass({
      template: t,
      registry,
      input: { name: 'A', club: 'a', url: '' },
      server: server(material),
      signing: material,
      assetOverrides: {
        'icon.png': { bytes: icon },
        'thumbnail@2x.png': { bytes: pngOf(180, 180) },
      },
    });
    const names = Object.keys(built.signed.files);
    expect(names).not.toContain('background.png');
    expect(names).toContain('thumbnail@2x.png');
    expect(built.signed.files['icon.png']).toEqual(icon);
  });

  it('drops image slots named by an image binding', async () => {
    const t = registry.add({
      id: 'drop',
      manifest: {
        ...manifest,
        bindings: [{ to: { image: 'thumbnail' }, remove: { input: 'club', eq: 'b' } }] as never,
      },
      passJson,
      assets: { 'icon.png': PNG, 'thumbnail.png': PNG, 'thumbnail@2x.png': PNG },
    });
    const run = (club: string, assetOverrides = {}) =>
      buildPass({
        template: t,
        registry,
        input: { name: 'A', club },
        server: server(material),
        signing: material,
        assetOverrides,
      });
    const kept = Object.keys((await run('a')).signed.files);
    expect(kept).toContain('thumbnail@2x.png');
    // @2x ships, so the @1x file stays out of the package.
    expect(kept).not.toContain('thumbnail.png');
    const dropped = Object.keys(
      (await run('b', { 'thumbnail@3x.png': { bytes: pngOf(270, 270) } })).signed.files,
    );
    expect(dropped.filter((n) => n.startsWith('thumbnail'))).toEqual([]);
  });

  it('rejects overrides that are not PNG image slots', async () => {
    const bad = (name: string, bytes: Uint8Array) =>
      buildPass({
        template,
        registry,
        input: { name: 'A', club: 'a', url: '' },
        server: server(material),
        signing: material,
        assetOverrides: { [name]: { bytes } },
      }).catch((e: unknown) => e);
    expect(((await bad('notes.txt', PNG)) as PassBuildError).code).toBe('INVALID_INPUT');
    expect(((await bad('thumbnail.png', new Uint8Array([1, 2, 3]))) as PassBuildError).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('applies input defaults before validating and binding', async () => {
    const t = registry.add({
      id: 'defaults',
      manifest: {
        ...manifest,
        inputs: {
          type: 'object',
          required: ['name', 'club'],
          properties: { name: { type: 'string' }, club: { type: 'string', default: 'b' } },
        },
      },
      passJson,
      assets: { 'icon.png': PNG },
    });
    const built = await buildPass({
      template: t,
      registry,
      input: { name: 'A' },
      server: server(material),
      signing: material,
    });
    expect(built.passJson.generic?.backFields?.map((f) => f.key)).not.toContain('only-a');
  });

  it('reports binding failures as TEMPLATE errors', async () => {
    const t = registry.add({
      id: 'badbind',
      manifest: { ...manifest, bindings: [{ to: { field: 'name' }, value: '{{name' }] },
      passJson,
      assets: { 'icon.png': PNG },
    });
    const error = await buildPass({
      template: t,
      registry,
      input: { name: 'A', club: 'a' },
      server: server(material),
      signing: material,
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('TEMPLATE');
  });
});

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
