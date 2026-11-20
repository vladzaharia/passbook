import type { PlannedPass } from '@/passkit/build.ts';
import type { ShippedAsset } from '@/passkit/build-assets.ts';
import type { AssetEntry, TemplateManifest } from '@/passkit/types.ts';
import { fidelityReport } from '@/passkit/wallets/fidelity.ts';
import { googleCompiler } from '@/passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '@/passkit/wallets/samsung/index.ts';
import type {
  CompileResult,
  FidelityReport,
  WalletCompiler,
  WalletTarget,
} from '@/passkit/wallets/types.ts';
import { resolveWalletView } from '@/passkit/wallets/view.ts';
import { assetUrlMap } from '../pass-card/assets.ts';
import type { PreviewSource } from './types.ts';

export interface WalletOut {
  compiled: CompileResult;
  report: FidelityReport;
}
export type WalletTargetOut = Record<Extract<WalletTarget, 'google' | 'samsung'>, WalletOut>;

const COMPILERS: Record<keyof WalletTargetOut, WalletCompiler> = {
  google: googleCompiler,
  samsung: samsungCompiler,
};

/**
 * The real compilers on the browser's copy of the pass: the same view, the same bodies and the
 * same fidelity report the release pipeline builds. Art is the template's own, by its dry-run URL.
 */
export function compileWallets(source: PreviewSource): WalletTargetOut {
  const manifest = source.manifest as unknown as TemplateManifest;
  const now = new Date();
  const urls = assetUrlMap(source.assetBaseUrl, source.assetNames);
  const previewOnly = new Set(manifest.previewOnlyAssets ?? []);
  const known = new Map(source.assets.map((a) => [a.name, a]));
  const shipped: ShippedAsset[] = source.assetNames
    .filter((name) => !previewOnly.has(name))
    .map((name) => {
      const file = known.get(name);
      return {
        name,
        ...(file?.width ? { width: file.width } : {}),
        ...(file?.height ? { height: file.height } : {}),
        // A file the version does not list is the pass's own: a wallet never gets it.
        ...(file ? {} : { bytes: new Uint8Array(0) }),
      };
    });
  const plan = {
    passJson: source.passJson,
    report: { ok: true, issues: [] },
    assets: shipped,
  } as unknown as PlannedPass;
  const origin = globalThis.location.origin;
  const view = resolveWalletView(plan, manifest, {
    now,
    locales: ['en'],
    input: source.input,
    assets: source.assets as unknown as AssetEntry[],
    assetUrl: (name) => urls[name],
    appLink: {
      name: String(source.passJson.organizationName ?? ''),
      url: origin,
      ...(urls['logo@3x.png'] ? { logo: urls['logo@3x.png'] } : {}),
    },
  });
  const out = {} as WalletTargetOut;
  for (const target of Object.keys(COMPILERS) as (keyof WalletTargetOut)[]) {
    const compiler = COMPILERS[target];
    const omit = manifest.wallets?.[target]?.omit ?? [];
    const compiled = compiler.compile(view, { now, omit, portalUrl: origin } as Parameters<
      WalletCompiler['compile']
    >[1]);
    const report = fidelityReport({
      target,
      compiler,
      views: [view],
      ...(manifest.wallets ? { wallets: manifest.wallets } : {}),
      now,
    });
    out[target] = { compiled, report };
  }
  return out;
}
