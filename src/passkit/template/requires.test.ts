import { describe, expect, it } from 'vitest';
import { PassBuildError, planPass } from '../build.ts';
import { FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { PassJson, TemplateManifest } from '../types.ts';
import { validateManifest } from './manifest.ts';
import { unmetRequirements } from './requires.ts';
import { InMemoryTemplateRegistry } from './in-memory-registry.ts';

const manifest = (requires: unknown): TemplateManifest =>
  ({
    schema: 1,
    name: 'T',
    inputs: { type: 'object', properties: { name: { type: 'string' } } },
    sample: {},
    bindings: [],
    display: { title: 'x' },
    requires,
  }) as TemplateManifest;

const passJson = {
  description: 'd',
  generic: { primaryFields: [{ key: 'a', value: 'b' }] },
} as unknown as PassJson;

const codes = (requires: unknown, withPass = true) =>
  validateManifest(manifest(requires), withPass ? { passJson } : {}).map((i) => i.code);

describe('requires', () => {
  it('accepts well-formed requirements', () => {
    expect(codes({ styles: ['generic'], nfc: false })).toEqual([]);
  });

  it('rejects malformed requirements', () => {
    expect(codes('x')).toContain('REQUIRES');
    expect(codes({ nfc: 'yes' })).toContain('REQUIRES');
    expect(codes({ styles: ['bogus'] })).toContain('REQUIRES');
    expect(codes({ other: 1 })).toContain('REQUIRES');
  });

  it('rejects a required style the pass.json does not draw', () => {
    expect(codes({ styles: ['coupon'] })).toContain('REQUIRES');
    expect(codes({ styles: ['coupon'] }, false)).toEqual([]);
  });

  it('reports an identity without NFC', () => {
    expect(unmetRequirements({ requires: { nfc: true } }, { nfcEnabled: false })).toHaveLength(1);
    expect(unmetRequirements({ requires: { nfc: true } }, { nfcEnabled: true })).toEqual([]);
    expect(unmetRequirements({}, {})).toEqual([]);
  });

  it('refuses to build when the identity lacks a required NFC entitlement', () => {
    const registry = new InMemoryTemplateRegistry();
    const template = registry.add({ id: 'n', manifest: manifest({ nfc: true }), passJson, assets: {} });
    const args = {
      template,
      registry,
      input: {},
      server: {
        serial: 's',
        authToken: 'a'.repeat(32),
        webServiceURL: 'https://wallet.example/wallet',
        organizationName: 'Org',
        identity: { ...FIXTURE_IDENTITY, nfcEnabled: false },
      },
      signing: undefined as never,
    };
    try {
      planPass(args);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PassBuildError);
      expect((error as PassBuildError).code).toBe('TEMPLATE');
    }
  });
});
