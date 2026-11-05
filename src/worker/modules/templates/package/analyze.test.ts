import { describe, expect, it } from 'vitest';
import { createBehaviorRegistry } from '../../../../passkit/behaviors/registry.ts';
import { type Analysis, analyzePackage } from './analyze.ts';
import { basicPackage, makePng, passJson } from './fixtures.ts';
import { ImageInvalid, type ImageTools } from './images.ts';

const behaviors = createBehaviorRegistry([
  {
    id: 'demo',
    version: 1,
    configSchema: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
    apply() {},
  },
]);

async function analyze(files: Map<string, Uint8Array>, images?: ImageTools, name?: string) {
  const result = await analyzePackage(files, {
    uploaded: true,
    fallbackName: 'Fallback',
    name,
    images,
    behaviors,
  });
  return {
    result,
    codes: result.report.issues.map((i) => `${i.severity}:${i.code}`),
    ok: 'version' in result,
    analysis: result as Analysis,
  };
}

const manifest = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    name: 'Gym',
    inputs: { type: 'object', properties: { name: { type: 'string' } } },
    sample: { name: 'Alex' },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}' },
    ...patch,
  });

describe('analyzePackage', () => {
  it('accepts a minimal package and generates a manifest', async () => {
    const { ok, codes, analysis } = await analyze(basicPackage());
    expect(ok).toBe(true);
    expect(codes).toContain('warning:MANIFEST_GENERATED');
    expect(analysis.manifestGenerated).toBe(true);
    expect(analysis.manifest.sample).toEqual({ name: 'Alex Morgan' });
    expect(analysis.manifest.bindings).toEqual([{ to: { field: 'name' }, value: '{{name}}' }]);
    expect(analysis.styles).toEqual(['generic']);
    const icon = analysis.assets.find((a) => a.name === 'icon@2x.png');
    expect(icon).toMatchObject({ slot: 'icon', scale: 2, width: 76, height: 76 });
    expect(icon?.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(icon?.crc32).toBeGreaterThan(0);
  });

  it('is deterministic and content addressed', async () => {
    const a = await analyze(basicPackage());
    const b = await analyze(new Map([...basicPackage()].reverse()));
    expect(a.analysis.version).toBe(b.analysis.version);
    expect(a.analysis.version).toMatch(/^[0-9a-f]{16}$/);
    const changed = await analyze(basicPackage({ 'logo.png': makePng(160, 50) }));
    expect(changed.analysis.version).not.toBe(a.analysis.version);
  });

  it('applies a name override to the manifest', async () => {
    const { analysis } = await analyze(basicPackage(), undefined, 'Renamed');
    expect(analysis.manifest.name).toBe('Renamed');
  });

  it('strips server fields from pass.json', async () => {
    const pass = passJson({ webServiceURL: 'https://x.test', authenticationToken: 'abc' });
    const { analysis } = await analyze(basicPackage({}, pass));
    expect(analysis.passJson).not.toHaveProperty('webServiceURL');
    expect(analysis.passJson).not.toHaveProperty('authenticationToken');
    expect(analysis.passJson).not.toHaveProperty('serialNumber');
  });

  it('rejects missing, oversized and malformed pass.json', async () => {
    expect((await analyze(basicPackage({ 'pass.json': null }))).codes).toContain(
      'error:PASS_JSON_MISSING',
    );
    expect((await analyze(basicPackage({ 'pass.json': '{nope' }))).codes).toContain(
      'error:PASS_JSON_INVALID',
    );
    expect((await analyze(basicPackage({ 'pass.json': '[]' }))).codes).toContain(
      'error:PASS_JSON_INVALID',
    );
    const big = JSON.stringify(passJson({ padding: 'x'.repeat(70_000) }));
    expect((await analyze(basicPackage({ 'pass.json': big }))).codes).toContain(
      'error:PASS_JSON_SIZE',
    );
    const noStyle = passJson();
    delete noStyle.generic;
    expect((await analyze(basicPackage({}, noStyle))).codes).toContain('error:NO_STYLE');
  });

  it('rejects names outside the allowlist', async () => {
    const { codes, ok } = await analyze(
      basicPackage({ 'script.js': 'alert(1)', 'icon@4x.png': makePng(38, 38) }),
    );
    expect(ok).toBe(false);
    expect(codes.filter((c) => c === 'error:NAME_NOT_ALLOWED')).toHaveLength(2);
  });

  it('rejects a bad PNG and wrong dimensions', async () => {
    const bad = await analyze(basicPackage({ 'logo.png': 'definitely not a png' }));
    expect(bad.codes).toContain('error:IMAGE_INVALID');
    const truncated = await analyze(basicPackage({ 'logo.png': makePng(100, 40).subarray(0, 60) }));
    expect(truncated.codes).toContain('error:IMAGE_INVALID');
    const corrupt = makePng(100, 40);
    corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 0xff;
    expect((await analyze(basicPackage({ 'logo.png': corrupt }))).codes).toContain(
      'error:IMAGE_INVALID',
    );
    const wrong = await analyze(basicPackage({ 'icon@2x.png': makePng(50, 50) }));
    expect(wrong.codes).toContain('error:IMAGE_SIZE');
    const tooBig = await analyze(basicPackage({ 'logo.png': makePng(161, 50) }));
    expect(tooBig.codes).toContain('error:IMAGE_SIZE');
    const huge = await analyze(basicPackage({ 'logo.png': makePng(5000, 1) }));
    expect(huge.codes).toContain('error:IMAGE_INVALID');
  });

  it('requires an icon', async () => {
    const { codes } = await analyze(basicPackage({ 'icon.png': null, 'icon@2x.png': null }));
    expect(codes).toContain('error:MISSING_ICON');
  });

  it('drops slots no declared style uses and warns', async () => {
    const { analysis, codes } = await analyze(
      basicPackage({ 'strip.png': makePng(375, 144), 'thumbnail.png': makePng(90, 90) }),
    );
    expect(codes).toContain('warning:SLOT_UNUSED');
    expect(analysis.assets.map((a) => a.name)).toContain('thumbnail.png');
    expect(analysis.assets.map((a) => a.name)).not.toContain('strip.png');
    expect(analysis.extras.map((e) => e.name)).toEqual(['strip.png']);
    expect(analysis.files.has('strip.png')).toBe(false);
  });

  it('keeps poster slots only for poster styles', async () => {
    const poster = passJson({ posterGeneric: { primaryFields: [{ key: 'a', value: 'b' }] } });
    delete poster.generic;
    const { analysis } = await analyze(
      basicPackage(
        { 'artwork.png': makePng(358, 448), 'background.png': makePng(345, 505) },
        poster,
      ),
    );
    expect(analysis.assets.map((a) => a.name)).toContain('artwork.png');
    expect(analysis.assets.map((a) => a.name)).not.toContain('background.png');
  });

  it('derives a missing @2x from @3x through the image backend', async () => {
    const calls: [number, number][] = [];
    const tools: ImageTools = {
      async resize(_bytes, w, h) {
        calls.push([w, h]);
        return makePng(w, h);
      },
    };
    const files = basicPackage({
      'icon.png': null,
      'icon@2x.png': null,
      'icon@3x.png': makePng(114, 114),
    });
    const { analysis, codes } = await analyze(files, tools);
    // Signed packages ship @2x and @3x only, so no @1x is derived.
    expect(calls).toEqual([[76, 76]]);
    expect(analysis.assets.map((a) => a.name)).toEqual(['icon@2x.png', 'icon@3x.png']);
    expect(codes.filter((c) => c === 'warning:IMAGE_DERIVED')).toHaveLength(1);
  });

  it('warns instead of failing when derivation is unavailable', async () => {
    const files = basicPackage({
      'icon.png': null,
      'icon@2x.png': null,
      'icon@3x.png': makePng(114, 114),
    });
    const { ok, codes } = await analyze(files);
    expect(ok).toBe(true);
    expect(codes).toContain('warning:IMAGE_SCALE_MISSING');
  });

  it('uses the image backend to reject undecodable or mismatched images', async () => {
    const invalid: ImageTools = {
      async info() {
        throw new ImageInvalid('no');
      },
    };
    expect((await analyze(basicPackage(), invalid)).codes).toContain('error:IMAGE_INVALID');
    const mismatch: ImageTools = {
      info: async () => ({ width: 1, height: 1, format: 'image/png' }),
    };
    expect((await analyze(basicPackage(), mismatch)).codes).toContain('error:IMAGE_INVALID');
    const jpeg: ImageTools = {
      info: async () => ({ width: 38, height: 38, format: 'image/jpeg' }),
    };
    expect((await analyze(basicPackage(), jpeg)).codes).toContain('error:IMAGE_FORMAT');
    const absent: ImageTools = { info: async () => null };
    expect((await analyze(basicPackage(), absent)).ok).toBe(true);
  });

  it('parses strings (UTF-8 and UTF-16) and flags broken or mismatched ones', async () => {
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...[...'"a" = "b";'].flatMap((c) => [c.charCodeAt(0), 0]),
    ]);
    const ok = await analyze(
      basicPackage({
        'en.lproj/pass.strings': '/* c */ "a" = "x";',
        'de.lproj/pass.strings': utf16,
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.codes).not.toContain('warning:STRINGS_KEYS');
    const broken = await analyze(basicPackage({ 'en.lproj/pass.strings': '"a" = "x"' }));
    expect(broken.codes).toContain('error:STRINGS_INVALID');
    const mismatch = await analyze(
      basicPackage({
        'en.lproj/pass.strings': '"a" = "x";',
        'de.lproj/pass.strings': '"b" = "y";',
      }),
    );
    expect(mismatch.codes).toContain('warning:STRINGS_KEYS');
  });

  it('warns when locales ship different images', async () => {
    const { codes } = await analyze(
      basicPackage({
        'en.lproj/logo.png': makePng(100, 40),
        'de.lproj/pass.strings': '"a" = "b";',
        'de.lproj/icon.png': makePng(38, 38),
      }),
    );
    expect(codes).toContain('warning:LOCALIZED_IMAGES');
  });
});

describe('uploaded manifests', () => {
  const run = (patch: Record<string, unknown>) =>
    analyze(basicPackage({ 'wallet.template.json': manifest(patch) }));

  it('accepts a valid manifest as is', async () => {
    const { ok, codes, analysis } = await run({});
    expect(ok).toBe(true);
    expect(analysis.manifestGenerated).toBe(false);
    expect(codes).not.toContain('warning:MANIFEST_GENERATED');
  });

  it('rejects an input named pass: it is the server scope in expressions', async () => {
    const { codes } = await run({
      inputs: {
        type: 'object',
        properties: { name: { type: 'string' }, pass: { type: 'string' } },
      },
    });
    expect(codes).toContain('error:INPUT_RESERVED');
  });

  it('rejects unsafe patterns and reference keywords but allows x- annotations', async () => {
    const props = (p: Record<string, unknown>) => ({
      inputs: { type: 'object', properties: { name: { type: 'string', ...p } } },
    });
    expect((await run(props({ pattern: '(a+)+$', maxLength: 10 }))).codes).toContain(
      'error:SCHEMA_PATTERN',
    );
    expect((await run(props({ pattern: '^[A-Z]+$' }))).codes).toContain('error:SCHEMA_PATTERN');
    expect((await run(props({ pattern: '^[A-Za-z]+$', maxLength: 10 }))).ok).toBe(true);
    expect((await run(props({ $ref: '#/x' }))).codes).toContain('error:SCHEMA_KEYWORD');
    expect((await run(props({ 'x-label': 'Name', maxLength: 10 }))).ok).toBe(true);
    const nested = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { pattern: { type: 'string', pattern: 'x+' } } },
      },
    };
    expect((await run({ inputs: nested })).codes).toContain('error:SCHEMA_PATTERN');
  });

  it('allows dependentRequired and rejects a malformed one', async () => {
    const schema = (dependentRequired: unknown) => ({
      inputs: {
        type: 'object',
        properties: { name: { type: 'string' }, b: { type: 'string' } },
        dependentRequired,
      },
      sample: { name: 'x', b: 'y' },
    });
    expect((await run(schema({ name: ['b'] }))).ok).toBe(true);
    expect((await run(schema({ name: 'b' }))).codes).toContain('error:SCHEMA_SHAPE');
  });

  it('rejects structurally wrong manifests', async () => {
    expect((await run({ schema: 2 })).codes).toContain('error:MANIFEST_SCHEMA');
    expect((await run({ name: '' })).codes).toContain('error:MANIFEST_NAME');
    expect((await run({ inputs: { type: 'string' } })).codes).toContain('error:MANIFEST_INPUTS');
    expect((await run({ bindings: 'x' })).codes).toContain('error:MANIFEST_BINDINGS');
    expect((await run({ bindings: [{ value: 'x' }] })).codes).toContain('error:BINDING_SHAPE');
    expect((await run({ bindings: [{ to: { field: 'name' }, value: 5 }] })).codes).toContain(
      'error:BINDING_VALUE',
    );
    expect(
      (await run({ bindings: [{ to: { field: 'name' }, when: { all: 'x' } }] })).codes,
    ).toContain('error:MANIFEST_CONDITION');
    expect((await run({ display: {} })).codes).toContain('error:MANIFEST_DISPLAY');
  });

  it('flags a sample that violates the input schema', async () => {
    const { codes } = await run({
      inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      sample: {},
    });
    expect(codes).toContain('error:SAMPLE_INVALID');
  });

  it('warns about unresolved targets and blocks non-allowlisted pointers', async () => {
    const warn = await run({ bindings: [{ to: { field: 'ghost' }, value: 'x' }] });
    expect(warn.ok).toBe(true);
    expect(warn.codes).toContain('warning:BINDING_TARGET');
    const pointer = await run({
      bindings: [{ to: { pointer: '/generic/primaryFields/0' }, value: 'x' }],
    });
    expect(pointer.codes).toContain('error:BINDING_POINTER');
    const allowed = await run({ bindings: [{ to: { pointer: '/logoText' }, value: 'x' }] });
    expect(allowed.ok).toBe(true);
    for (const pointer of [
      '/relevantDates/0/startDate',
      '/semantics/eventName',
      '/semantics/balance/amount',
      '/locations/0/latitude',
      '/boardingPass/transitType',
      '/preferredStyleSchemes',
    ])
      expect(
        (await run({ bindings: [{ to: { pointer }, value: 'x' }] })).codes,
        pointer,
      ).not.toContain('error:BINDING_POINTER');
    for (const pointer of [
      '/serialNumber',
      '/webServiceURL',
      '/barcodes/0/message',
      '/generic/headerFields',
    ])
      expect((await run({ bindings: [{ to: { pointer }, value: 'x' }] })).codes, pointer).toContain(
        'error:BINDING_POINTER',
      );
  });

  it('checks behaviors against the registry and their config schema', async () => {
    const use = (v: Record<string, unknown>) => ({
      behaviors: [{ use: 'demo', version: 1, config: {}, ...v }],
    });
    expect((await run({ behaviors: [{ use: 'ghost', version: 1, config: {} }] })).codes).toContain(
      'error:BEHAVIOR_UNKNOWN',
    );
    expect((await run(use({}))).codes).toContain('error:BEHAVIOR_CONFIG');
    expect((await run(use({ config: { x: 'ok' } }))).ok).toBe(true);
    expect((await run(use({ config: { x: 'ok' }, version: 9 }))).codes).toContain(
      'warning:BEHAVIOR_VERSION',
    );
  });

  it('rejects invalid manifest JSON', async () => {
    const { codes } = await analyze(basicPackage({ 'wallet.template.json': '{' }));
    expect(codes).toContain('error:MANIFEST_INVALID');
  });
});
