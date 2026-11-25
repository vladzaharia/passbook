import type { PassJson } from '../../../passkit/types.ts';
import {
  type SamsungCardData,
  type SamsungCompileOptions,
  samsungCardBody,
  samsungCompiler,
  samsungPortalUrl,
} from '../../../passkit/wallets/samsung/index.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { previewPlan } from '../templates/build-check.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { prepareProjectionArt, sizeShipped, type WalletArt } from './projection-art.ts';
import type { ProjectionV2 } from './projection-contract.ts';
import { orgWebsite } from './projection-pins.ts';
import { recordProjectionArt } from './repo-projection-art.ts';
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
  /** The approved candidate: art cut here is recorded against it, so a purge finds it. */
  candidateId: string;
}

/** Art is content-addressed per template version: a bounded, short-lived memo of one cut. */
const ART_TTL_MS = 600_000;
const ART_CAP = 64;
const artByVersion = new Map<string, { until: number; art: Promise<WalletArt> }>();

function memoArt(key: string, now: number, cut: () => Promise<WalletArt>): Promise<WalletArt> {
  for (const [k, v] of artByVersion) if (v.until <= now) artByVersion.delete(k);
  const hit = artByVersion.get(key);
  if (hit) return hit.art;
  while (artByVersion.size >= ART_CAP) {
    const oldest = artByVersion.keys().next().value;
    if (oldest === undefined) break;
    artByVersion.delete(oldest);
  }
  const art = cut();
  artByVersion.set(key, { until: now + ART_TTL_MS, art });
  art.catch(() => artByVersion.delete(key));
  return art;
}

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
  const zone = await readOrgTimeZone(ctx.env.DB, pass.orgId);
  const plan = previewPlan(
    ctx.env,
    template,
    template.manifest.sample,
    template.passJson.organizationName,
    now,
    zone,
  );
  const key = `${input.candidateId}|${input.art}`;
  const art = await memoArt(key, now.getTime(), async () => {
    const cut = await prepareProjectionArt(
      ctx,
      registry,
      template,
      'samsung',
      plan.assets,
      input.art,
    );
    // What a runtime cut wrote is recorded like release art, so a purge removes it.
    if (input.art === 'store' && cut.hashes.size > 0)
      await recordProjectionArt(ctx.env.DB, {
        candidateId: input.candidateId,
        hashes: [...cut.hashes],
        now: now.getTime(),
      });
    return cut;
  });
  const view = resolveWalletView(
    {
      ...plan,
      passJson: input.passJson as unknown as PassJson,
      assets: sizeShipped(plan.assets, art),
    },
    template.manifest,
    {
      now,
      timeZone: zone,
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
    portalUrl: samsungPortalUrl(baseUrl(ctx.env), await orgWebsite(ctx, pass.orgId)),
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
