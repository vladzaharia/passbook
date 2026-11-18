import { fidelityReport, omissionKeys, reportHash } from '../../../passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '../../../passkit/wallets/samsung/index.ts';
import type {
  FidelityReport,
  WalletCompiler,
  WalletPassView,
} from '../../../passkit/wallets/types.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { previewPlan } from '../templates/build-check.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import type { VersionRow } from '../templates/repo.ts';
import { deriveProjectionArt, type WalletArt } from './projection-art.ts';
import type { NativeProvider, ProjectionV2 } from './projection-contract.ts';

const COMPILERS: Record<NativeProvider, WalletCompiler> = {
  google: googleCompiler,
  samsung: samsungCompiler,
};

export const compilerRevision = (provider: NativeProvider): number => COMPILERS[provider].revision;

/** The hash a candidate pins for a version's `wallets` block (`null` when it has none). */
export const walletsHash = (wallets: unknown): Promise<string> =>
  sha256Hex(canonicalJson(wallets ?? null));

export interface ComputedProjection {
  pins: ProjectionV2;
  report: FidelityReport;
  /** What the compiler read: the sample's view and the art addresses it was given. */
  view: WalletPassView;
  art: WalletArt;
}

/**
 * Compiles the version's sample for `provider` and pins what a reviewer approves. Everything comes
 * from the immutable version (its own creation time, its own organization name, no tenant
 * settings), so the same version and compiler always give the same pins.
 */
export async function computeProjectionPins(
  ctx: ServiceContext,
  provider: NativeProvider,
  version: VersionRow,
): Promise<ComputedProjection> {
  const compiler = COMPILERS[provider];
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(version.templateId, version.version);
  const now = new Date(version.createdAt);
  const plan = previewPlan(
    ctx.env,
    template,
    template.manifest.sample,
    template.passJson.organizationName,
    now,
  );
  const art = await deriveProjectionArt(
    ctx,
    registry,
    template,
    provider,
    plan.assets.map((a) => a.name),
  );
  const sized = <T extends { name: string; width?: number; height?: number }>(a: T): T => {
    const size = art.sizes.get(a.name);
    return size ? { ...a, ...size } : a;
  };
  const view = resolveWalletView({ ...plan, assets: plan.assets.map(sized) }, template.manifest, {
    now,
    locales: [],
    input: template.manifest.sample,
    assets: template.assets.map(sized),
    assetUrl: (name) => art.urls.get(name),
  });
  const wallets = template.manifest.wallets;
  const report = fidelityReport({ target: provider, compiler, views: [view], now, wallets });
  return {
    report,
    view,
    art,
    pins: {
      schema: 2,
      provider,
      type: report.type,
      compilerRevision: compiler.revision,
      wallets: await walletsHash(wallets),
      report: await reportHash(report),
      approvedOmissions: omissionKeys(report),
    },
  };
}

/** Pins are equal when every field is; omissions are compared as sorted sets. */
export function samePins(a: ProjectionV2, b: ProjectionV2): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A report a release cannot be built from: the target is off or the pass is not offered. */
export const unreleasable = (report: FidelityReport): boolean =>
  report.status.kind === 'off' || report.status.kind === 'blocked';

/**
 * Q21. A compiler update that adds an omission (or blocks the pass) pauses new offers for the
 * release until it is re-approved. State changes for passes already on the wallet keep flowing.
 * Only a changed compiler revision can change the report, so only then is it recomputed.
 */
export async function offersPausedByCompiler(
  ctx: ServiceContext,
  pinned: ProjectionV2,
  version: VersionRow,
): Promise<boolean> {
  if (pinned.compilerRevision === compilerRevision(pinned.provider)) return false;
  const { pins, report } = await computeProjectionPins(ctx, pinned.provider, version);
  if (unreleasable(report)) return true;
  const approved = new Set(pinned.approvedOmissions);
  return pins.approvedOmissions.some((key) => !approved.has(key));
}
