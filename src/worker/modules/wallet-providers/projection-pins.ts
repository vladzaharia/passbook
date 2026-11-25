import type { PlannedPass } from '../../../passkit/build.ts';
import { evaluate } from '../../../passkit/template/expr.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization } from '../../../passkit/types.ts';
import { fidelityReport, omissionKeys, reportHash } from '../../../passkit/wallets/fidelity.ts';
import { samsungPortalUrl } from '../../../passkit/wallets/samsung/index.ts';
import type { FidelityReport, WalletPassView } from '../../../passkit/wallets/types.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { baseUrl } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { previewPlan } from '../templates/build-check.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import type { VersionRow } from '../templates/repo.ts';
import { prepareProjectionArt, sizeShipped, type WalletArt } from './projection-art.ts';
import { classProbes, conditionLiterals, withClassRule } from './projection-class-rule.ts';
import type { NativeProvider, ProjectionV2 } from './projection-contract.ts';
import { COMPILERS, pipelineRevision } from './projection-pipeline.ts';

/** The hash a candidate pins for a version's `wallets` block (`null` when it has none). */
export const walletsHash = (wallets: unknown): Promise<string> =>
  sha256Hex(canonicalJson(wallets ?? null));

/** The organization's `org.website` setting, if it has one (Q22). */
export async function orgWebsite(ctx: ServiceContext, orgId?: string): Promise<string | undefined> {
  return orgId ? (await getOrgSettings(ctx, orgId))['org.website'] : undefined;
}

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
  /** The organization whose website is the Samsung app link; none: the holder portal. */
  orgId?: string,
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
  const viewOf = (planned: PlannedPass, input: Personalization) =>
    resolveWalletView({ ...planned, assets: sizeShipped(planned.assets, art) }, template.manifest, {
      now,
      // Pins come from the immutable version alone, with no tenant settings: the default zone.
      timeZone: DEFAULT_TIME_ZONE,
      locales: [],
      input,
      assets: template.assets.map((asset) => {
        const size = art.sizes.get(asset.name);
        return size ? { ...asset, ...size } : asset;
      }),
      assetUrl: (name) => art.urls.get(name),
    });
  const view = viewOf(plan, template.manifest.sample);
  const wallets = template.manifest.wallets;
  // A class holds one body for every pass of its key (L2): a design whose class fields move with pass data
  // is blocked here, at review, not discovered as drift.
  const reviewed =
    provider === 'google'
      ? withClassRule(
          compiler,
          classProbes(
            template.manifest.inputs,
            template.manifest.sample,
            wallets?.google?.classKey,
            (input) =>
              viewOf(
                previewPlan(ctx.env, template, input, template.passJson.organizationName, now),
                input,
              ),
            {
              keyOf: (input) =>
                evaluate(wallets?.google?.classKey ?? '', {
                  input: applyDefaults(template.manifest, input),
                  lookups: template.manifest.lookups ?? {},
                }),
              literals: conditionLiterals(template.manifest),
            },
          ),
        )
      : compiler;
  const report = fidelityReport({
    target: provider,
    compiler: reviewed,
    views: [view],
    now,
    wallets,
    ...(provider === 'samsung'
      ? {
          compile: {
            portalUrl: samsungPortalUrl(baseUrl(ctx.env), await orgWebsite(ctx, orgId)),
          },
        }
      : {}),
  });
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
  /** The org that owns the release: its website is part of what compiles (Q22). */
  orgId?: string,
): Promise<boolean> {
  if (pinned.pipeline === (await pipelineRevision(pinned.provider))) return false;
  return !carriesForward(
    pinned,
    await computeProjectionPins(ctx, pinned.provider, version, 'dry', orgId),
  );
}
