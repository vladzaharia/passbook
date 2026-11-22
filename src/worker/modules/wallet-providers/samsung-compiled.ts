import type { PassJson } from '../../../passkit/types.ts';
import {
  type SamsungCardData,
  type SamsungCompileOptions,
  samsungCardBody,
  samsungCompiler,
} from '../../../passkit/wallets/samsung/index.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { previewPlan } from '../templates/build-check.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { prepareProjectionArt, sizeShipped, type WalletArt } from './projection-art.ts';
import type { ProjectionV2 } from './projection-contract.ts';
import { walletPortalUrl } from './projection-pins.ts';
import type { SamsungCardProjection } from './samsung-token.ts';

interface SamsungCompiledInput {
  projection: ProjectionV2;
  pass: Pass;
  /** The pass as Apple holds it now. */
  passJson: Record<string, unknown>;
  refId: string;
  /** When the provider reference was created, and when the pass last changed. */
  createdAt: number;
  revisedAt: number;
  /** `dry` sizes the art (checks); `store` cuts the public copies a card links to. */
  art: 'dry' | 'store';
}

/** Art is content-addressed per template version: one cut per isolate is enough. */
const artByVersion = new Map<string, Promise<WalletArt>>();

/**
 * The Get Card Data body of one pass, compiled from the pass as it is now. Null when the pass no
 * longer compiles to the approved type, is blocked, or the target is off: nothing is then served.
 */
export async function compileSamsungCard(
  ctx: ServiceContext,
  input: SamsungCompiledInput,
): Promise<SamsungCardProjection | null> {
  const { projection, pass } = input;
  if (
    !/^[A-Za-z0-9_-]{32}$/.test(input.refId) ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.revisedAt)
  )
    return null;
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(pass.templateId, pass.templateVersion);
  const now = new Date(ctx.clock.now());
  const plan = previewPlan(
    ctx.env,
    template,
    template.manifest.sample,
    template.passJson.organizationName,
    now,
  );
  const key = `${pass.orgId}|${pass.templateId}|${pass.templateVersion}|${input.art}`;
  let cut = artByVersion.get(key);
  if (!cut) {
    cut = prepareProjectionArt(ctx, registry, template, 'samsung', plan.assets, input.art);
    artByVersion.set(key, cut);
    cut.catch(() => artByVersion.delete(key));
  }
  const art = await cut;
  const view = resolveWalletView(
    {
      ...plan,
      passJson: input.passJson as unknown as PassJson,
      assets: sizeShipped(plan.assets, art),
    },
    template.manifest,
    {
      now,
      locales: [],
      input: pass.personalization,
      ...(pass.scanCode ? { pass: { scanCode: pass.scanCode } } : {}),
      assets: template.assets.map((asset) => {
        const size = art.sizes.get(asset.name);
        return size ? { ...asset, ...size } : asset;
      }),
      assetUrl: (name) => art.urls.get(name),
    },
  );
  const options: SamsungCompileOptions = {
    now,
    omit: template.manifest.wallets?.samsung?.omit ?? [],
    portalUrl: walletPortalUrl(ctx.env),
    issuedAt: new Date(input.createdAt),
  };
  const result = samsungCompiler.compile(view, options);
  // A type that moved since approval is Q21's: the release is re-approved, not served as it is.
  if (result.blocked || !result.cardData || result.type !== projection.type) return null;
  return samsungCardBody(result.cardData as SamsungCardData, {
    refId: input.refId,
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(Math.max(input.createdAt, input.revisedAt)),
  });
}
