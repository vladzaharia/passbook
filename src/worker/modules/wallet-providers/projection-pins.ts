import { WALLET_CAPABILITIES } from '../../../generated/wallet-capabilities.ts';
import { WALLET_ART_RULES } from '../../../passkit/template/wallets/art-rules.ts';
import {
  FIDELITY_REVISION,
  fidelityReport,
  omissionKeys,
  reportHash,
} from '../../../passkit/wallets/fidelity.ts';
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
import { prepareProjectionArt, sizeShipped, type WalletArt } from './projection-art.ts';
import type { NativeProvider, ProjectionV2 } from './projection-contract.ts';

const COMPILERS: Record<NativeProvider, WalletCompiler> = {
  google: googleCompiler,
  samsung: samsungCompiler,
};

/** The generated matrix and the art rules are constants of the build: hashed once per isolate. */
const staticPins = new Map<NativeProvider, Promise<string>>();
const staticPin = (provider: NativeProvider): Promise<string> => {
  let pin = staticPins.get(provider);
  if (!pin) {
    pin = sha256Hex(
      canonicalJson({
        capabilities: WALLET_CAPABILITIES[provider],
        art: WALLET_ART_RULES[provider],
      }),
    );
    staticPins.set(provider, pin);
  }
  return pin;
};

/** Everything but the version that decides a report: compiler, fidelity engine, matrix, art rules. */
export async function pipelineRevision(provider: NativeProvider): Promise<string> {
  return sha256Hex(
    canonicalJson({
      compiler: COMPILERS[provider].revision,
      fidelity: FIDELITY_REVISION,
      static: await staticPin(provider),
    }),
  );
}

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
 * settings), so the same version and pipeline always give the same pins. `dry` only sizes art;
 * `store` writes the public copies and belongs to release publication.
 */
export async function computeProjectionPins(
  ctx: ServiceContext,
  provider: NativeProvider,
  version: VersionRow,
  mode: 'dry' | 'store' = 'dry',
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
  const art = await prepareProjectionArt(ctx, registry, template, provider, plan.assets, mode);
  const view = resolveWalletView(
    { ...plan, assets: sizeShipped(plan.assets, art) },
    template.manifest,
    {
      now,
      locales: [],
      input: template.manifest.sample,
      assets: template.assets.map((asset) => {
        const size = art.sizes.get(asset.name);
        return size ? { ...asset, ...size } : asset;
      }),
      assetUrl: (name) => art.urls.get(name),
    },
  );
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
      pipeline: await pipelineRevision(provider),
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
 * The Q21 rule, shared by the offer pause and by rollback: an approval still covers the current
 * pipeline when the target is releasable, the compiled type is the pinned one and every omission
 * the report has now was approved. Fewer omissions (or none) carry forward.
 */
export function carriesForward(pinned: ProjectionV2, current: ComputedProjection): boolean {
  const approved = new Set(pinned.approvedOmissions);
  return (
    !unreleasable(current.report) &&
    current.pins.type === pinned.type &&
    current.pins.approvedOmissions.every((key) => approved.has(key))
  );
}

/**
 * Q21. A pipeline change that adds an omission, changes the type or blocks the pass pauses new
 * offers for the release until it is re-approved. State changes for passes already on the wallet
 * keep flowing. Only a changed pipeline can change the report, so only then is it recomputed.
 */
export async function pipelineAddsLoss(
  ctx: ServiceContext,
  pinned: ProjectionV2,
  version: VersionRow,
): Promise<boolean> {
  if (pinned.pipeline === (await pipelineRevision(pinned.provider))) return false;
  return !carriesForward(pinned, await computeProjectionPins(ctx, pinned.provider, version, 'dry'));
}
