import { describe, expect, it } from 'vitest';
import { behaviors } from '../build-check.ts';
import { generatedSource } from '../sync.ts';
import { type Analysis, analyzePackage } from './analyze.ts';
import { basicPackage, makePng } from './fixtures.ts';
import { buildKey } from './hash.ts';
import { classify } from './names.ts';

const encoder = new TextEncoder();

const WALLETS = {
  schema: 1,
  roles: { memberId: { field: 'member' }, tier: { value: '{{tier}}' } },
  required: ['barcode.format'],
  google: { type: 'loyalty', images: { logo: 'wallets/google/logo.png' } },
  samsung: { type: 'loyalty', subType: 'others', images: { main: 'wallets/samsung/main.png' } },
};

const starter = (() => {
  const found = generatedSource.templates.find((t) => t.slug === 'starter-store-card');
  if (!found) throw new Error('starter-store-card is not baked');
  return found;
})();
const { blueprint: _blueprint, wallets: _wallets, ...starterManifest } = starter.manifest;

const art = () => ({
  'wallets/google/logo.png': makePng(660, 660),
  'wallets/samsung/main.png': makePng(32, 20),
});

function packageOf(
  wallets?: unknown,
  files: Record<string, Uint8Array | null> = art(),
  patch: Record<string, unknown> = {},
) {
  const manifest = { ...starterManifest, ...patch, ...(wallets === undefined ? {} : { wallets }) };
  return basicPackage(
    { 'wallet.template.json': JSON.stringify(manifest), ...files },
    starter.passJson as Record<string, unknown>,
  );
}

async function analyze(files: Map<string, Uint8Array>) {
  const result = await analyzePackage(files, { uploaded: true, fallbackName: 'Card', behaviors });
  const issues = result.report.issues.map((i) => `${i.severity}:${i.code}`);
  return { result, issues, analysis: result as Analysis, ok: 'version' in result };
}

const keyOf = (a: Analysis) =>
  buildKey({ passJson: a.passJson, manifest: a.manifest, assets: a.assets });

describe('a starter with a wallets block', () => {
  it('is accepted, and keeps the art as unshipped source files', async () => {
    const { ok, issues, analysis } = await analyze(packageOf(WALLETS));
    expect(issues.filter((i) => i.startsWith('error'))).toEqual([]);
    expect(ok).toBe(true);
    expect(analysis.manifest.wallets).toEqual(WALLETS);
    const kept = analysis.assets.filter((a) => a.name.startsWith('wallets/'));
    expect(kept.map((a) => [a.name, a.slot, a.width, a.height])).toEqual([
      ['wallets/google/logo.png', 'source', 660, 660],
      ['wallets/samsung/main.png', 'source', 32, 20],
    ]);
    expect(analysis.files.has('wallets/google/logo.png')).toBe(true);
  });

  it('has the Apple build key of the same starter without it', async () => {
    const plain = await analyze(packageOf(undefined, {}));
    const extended = await analyze(packageOf(WALLETS));
    expect(plain.ok && extended.ok).toBe(true);
    expect(await keyOf(extended.analysis)).toBe(await keyOf(plain.analysis));
    // The version hash is the author's edit history: it does change.
    expect(extended.analysis.version).not.toBe(plain.analysis.version);
  });

  it('changes the build key only for what Apple reads', async () => {
    const base = await analyze(packageOf(WALLETS));
    const edited = await analyze(packageOf({ ...WALLETS, roles: {} }));
    const repainted = await analyze(
      packageOf(WALLETS, { ...art(), 'wallets/google/logo.png': makePng(700, 700) }),
    );
    expect(await keyOf(edited.analysis)).toBe(await keyOf(base.analysis));
    expect(await keyOf(repainted.analysis)).toBe(await keyOf(base.analysis));
    expect(edited.analysis.version).not.toBe(base.analysis.version);
    expect(repainted.analysis.version).not.toBe(base.analysis.version);
    const retitled = await analyze(packageOf(WALLETS, art(), { display: { title: 'Other' } }));
    expect(await keyOf(retitled.analysis)).not.toBe(await keyOf(base.analysis));
  });

  it('round-trips through its own files: same version, key, assets and bytes', async () => {
    const first = await analyze(packageOf(WALLETS));
    const again = new Map<string, Uint8Array>(first.analysis.files);
    again.set('pass.json', encoder.encode(JSON.stringify(first.analysis.passJson)));
    again.set('wallet.template.json', encoder.encode(JSON.stringify(first.analysis.manifest)));
    const second = await analyze(again);
    expect(second.ok).toBe(true);
    expect(second.analysis.version).toBe(first.analysis.version);
    expect(await keyOf(second.analysis)).toBe(await keyOf(first.analysis));
    expect(second.analysis.assets).toEqual(first.analysis.assets);
    expect(second.analysis.manifest.wallets).toEqual(WALLETS);
    for (const name of ['wallets/google/logo.png', 'wallets/samsung/main.png'])
      expect(second.analysis.files.get(name)).toEqual(first.analysis.files.get(name));
  });

  it('leaves a template without the block as it is', async () => {
    const { ok, issues, analysis } = await analyze(packageOf(undefined, {}));
    expect(ok).toBe(true);
    expect(issues.filter((i) => /WALLET/.test(i))).toEqual([]);
    expect(analysis.manifest).not.toHaveProperty('wallets');
    expect(analysis.assets.filter((a) => a.name.startsWith('wallets/'))).toEqual([]);
  });
});

describe('wallets block checks at upload', () => {
  it('errors on an invalid block', async () => {
    const { ok, issues } = await analyze(packageOf({ ...WALLETS, schema: 2, stray: true }));
    expect(ok).toBe(false);
    expect(issues).toEqual(
      expect.arrayContaining(['error:WALLETS_VERSION', 'error:WALLETS_UNKNOWN_KEY']),
    );
  });

  it('errors on art the block names but the package lacks', async () => {
    const { ok, issues } = await analyze(
      packageOf(WALLETS, { 'wallets/google/logo.png': makePng(660, 660) }),
    );
    expect(ok).toBe(false);
    expect(issues).toContain('error:WALLETS_IMAGE_MISSING');
  });

  it('warns on art nothing names, and still accepts the package', async () => {
    const { ok, issues } = await analyze(packageOf({ schema: 1 }));
    expect(ok).toBe(true);
    expect(issues).toContain('warning:WALLETS_ART_UNUSED');
  });

  it('errors on art that is not a PNG', async () => {
    const { ok, issues } = await analyze(
      packageOf(WALLETS, { ...art(), 'wallets/samsung/main.png': encoder.encode('not a png') }),
    );
    expect(ok).toBe(false);
    expect(issues).toContain('error:WALLET_ART_PNG');
  });

  it('refuses file names outside wallets/<google|samsung>/', async () => {
    for (const name of ['wallets/apple/logo.png', 'wallets/google/a/b.png', 'wallets/logo.png']) {
      const { ok, issues } = await analyze(packageOf(WALLETS, { ...art(), [name]: makePng(8, 8) }));
      expect(ok).toBe(false);
      expect(issues).toContain('error:NAME_NOT_ALLOWED');
    }
  });
});

describe('file names', () => {
  it('classifies per-wallet art, and nothing else under wallets/', () => {
    expect(classify('wallets/google/logo.png')).toEqual({ kind: 'walletArt' });
    expect(classify('wallets/samsung/main-2.png')).toEqual({ kind: 'walletArt' });
    expect(classify('wallets/google/logo.jpg')).toBeNull();
    expect(classify('wallets/apple/logo.png')).toBeNull();
    expect(classify('wallets/google/x/logo.png')).toBeNull();
    expect(classify('wallets/logo.png')).toBeNull();
  });
});
