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
});
