import type { PlannedPass } from '../../../passkit/build.ts';
import type { ShippedAsset } from '../../../passkit/build-assets.ts';
import { evaluate } from '../../../passkit/template/expr.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import type { Pass } from '../passes/repo-map.ts';
import { currentPassJson } from '../passes/repo-read-pass.ts';
import { timedOrBuilt } from '../passes/timed-source.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { walletArtExists } from './assets.ts';
import { GoogleWalletError } from './google-errors.ts';
import { googleClassKeyDigest } from './google-ids.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import { sizeShipped, type WalletArt } from './projection-art.ts';
import type { NativeProjection } from './projection-contract.ts';
import { listProjectionArtFiles } from './repo-projection-art.ts';

/** Which class a pass belongs to: its type and the digest of its `google.classKey` (absent: default). */
export interface GoogleClassPartition {
  type: GoogleType;
  classKey?: string;
}

/** The bodies the compiler made, as JSON the runtime sends: ids and callback options are added there. */
export type GoogleCompiled = GoogleClassPartition & {
  classBody: GoogleGenericProjection;
  objectBody: GoogleGenericProjection;
};

/** Why a pass cannot be compiled now. None of these is a provider fault, so none is retried. */
export type GoogleCompileFailure = 'unreadable' | 'blocked' | 'type_changed' | 'art_missing';

/** The type a schema 2 release was approved for; schema 1 is always Generic. */
export const projectionGoogleType = (projection: NativeProjection): GoogleType =>
  projection.schema === 2 ? (projection.type as GoogleType) : 'generic';

export async function partitionOf(
  template: ResolvedTemplate,
  pass: Pass,
  type: GoogleType,
): Promise<GoogleClassPartition> {
  const expr = template.manifest.wallets?.google?.classKey;
  if (expr === undefined) return { type };
  const value = evaluate(expr, {
    input: applyDefaults(template.manifest, pass.personalization),
    lookups: template.manifest.lookups ?? {},
  });
  if (typeof value === 'object' && value !== null)
    throw new GoogleWalletError('invalid_input', 'class key');
  // Only an empty key is the default class: a key that reads `default` is a class of its own.
  const key = value === undefined || value === null ? '' : String(value).trim();
  return key === '' ? { type } : { type, classKey: await googleClassKeyDigest(key) };
}

/** The class partition alone, for a caller that only needs the ids (callback bindings, offers). */
export async function googleClassPartition(
  ctx: ServiceContext,
  pass: Pass,
  projection: NativeProjection,
): Promise<GoogleClassPartition> {
  if (projection.schema !== 2) return { type: 'generic' };
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  return partitionOf(template, pass, projectionGoogleType(projection));
}

/**
 * The compiler output for the pass as it is now, under the release's pinned type. The art is what the
 * release published (`candidateId`'s stored copies); a claim never cuts an image. A copy that is not in
 * storage is `art_missing`: the caller queues `wallet.google_art` and the claim retries.
 */
export async function compileGooglePass(
  ctx: ServiceContext,
  pass: Pass,
  projection: NativeProjection,
  candidateId: string,
): Promise<GoogleCompiled | GoogleCompileFailure> {
  if (projection.schema !== 2 || projection.provider !== 'google') return 'unreadable';
  const raw = await currentPassJson(ctx.env.DB, pass.id);
  let passJson: unknown;
  try {
    passJson = raw === null ? null : JSON.parse(raw);
  } catch {
    passJson = null;
  }
  if (passJson === null || typeof passJson !== 'object') return 'unreadable';
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  // The card shows the event running now, as Apple's timed render does.
  passJson = timedOrBuilt(
    ctx,
    pass.id,
    passJson as PassJson,
    pass.personalization,
    template,
    ctx.clock.now(),
  );
  const previewOnly = new Set(template.manifest.previewOnlyAssets ?? []);
  const shipped: ShippedAsset[] = template.assets
    .filter((asset) => !previewOnly.has(asset.name))
    .map((asset) => ({
      name: asset.name,
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
    }));
  const files = await listProjectionArtFiles(ctx.env.DB, candidateId);
  const present = await Promise.all(files.map((file) => walletArtExists(ctx.env, file.sha256)));
  if (present.includes(false)) return 'art_missing';
  const origin = baseUrl(ctx.env);
  const art: WalletArt = {
    urls: new Map(files.map((f) => [f.asset, `${origin}/w/i/${f.sha256}.png`])),
    sizes: new Map(files.map((f) => [f.asset, { width: f.width, height: f.height }])),
    hashes: new Set(),
  };
  const now = new Date(ctx.clock.now());
  const view = resolveWalletView(
    {
      passJson,
      report: { ok: true, issues: [] },
      assets: sizeShipped(shipped, art),
    } as unknown as PlannedPass,
    template.manifest,
    {
      now,
      timeZone: await readOrgTimeZone(ctx.env.DB, pass.orgId),
      locales: [],
      input: pass.personalization,
      assets: template.assets.map((asset) => {
        const size = art.sizes.get(asset.name);
        return size ? { ...asset, ...size } : asset;
      }),
      assetUrl: (name) => art.urls.get(name),
    },
  );
  const compiled = googleCompiler.compile(view, {
    now,
    omit: template.manifest.wallets?.google?.omit ?? [],
  });
  if (compiled.blocked || !compiled.classBody || !compiled.objectBody) return 'blocked';
  const type = projectionGoogleType(projection);
  if (compiled.type !== type) return 'type_changed';
  return {
    ...(await partitionOf(template, pass, type)),
    classBody: compiled.classBody as GoogleGenericProjection,
    objectBody: compiled.objectBody as GoogleGenericProjection,
  };
}
