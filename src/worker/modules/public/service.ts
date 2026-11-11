import type { PassJson } from '../../../passkit/types.ts';
import { safeMail, safeUrl } from '../../email/safe.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { orgBranding } from '../delivery/repo.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { replacedBy } from '../passes/assets.ts';
import { readBranding } from '../passes/branding.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import type { Pass } from '../passes/repo.ts';
import { listAssets } from '../passes/repo-history-assets.ts';
import { memberPhotoAsset } from '../passes/repo-member-photo.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { getPassByDownloadToken } from '../passes/repo-read-pass.ts';
import { getRemoval } from '../passes/repo-remove.ts';
import { getOrgSettings } from '../settings/service.ts';
import { canPresent } from './presentation.ts';
import { currentPublicGeneration, getPassAsset, passJsonAtVersion } from './repo.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const ASSET_NAME = /^[A-Za-z0-9_@.-]{1,100}\.png$/;

export const isTokenShape = (token: string) => TOKEN.test(token);

const notFound = () => new NotFoundError('This link is not valid.', 'LINK_NOT_FOUND');

/** Bearer-link lookup. A rotated token or a pending transfer never resolves. */
export async function passForToken(ctx: ServiceContext, token: string): Promise<Pass> {
  if (!isTokenShape(token)) throw notFound();
  const pass = await getPassByDownloadToken(ctx.env.DB, token);
  if (!pass || !(await currentPublicGeneration(ctx.env.DB, pass))) throw notFound();
  return pass;
}

export interface SupportContacts {
  email: string | null;
  url: string | null;
  /** PassBook's own support, because the org has none. */
  platform?: true;
}

/** Org settings win over the legacy branding fields; unsafe values are dropped. */
export async function supportContacts(
  ctx: ServiceContext,
  orgId: string,
): Promise<SupportContacts> {
  const [settings, branding] = await Promise.all([
    getOrgSettings(ctx, orgId),
    orgBranding(ctx.env.DB, orgId),
  ]);
  const email = safeMail(settings['support.email'] ?? branding.supportEmail);
  const url = safeUrl(settings['support.url'] ?? branding.supportUrl);
  if (email || url) return { email, url };
  const platform = platformSupportEmail(ctx.env);
  return platform ? { email: platform, url: null, platform: true } : { email, url };
}

export interface PublicPageModel {
  passJson: PassJson;
  /** The org's name, when the pass names none. */
  orgName: string;
  /** Asset name -> current bearer URL, cache-busted by content hash. */
  assets: Record<string, string>;
  /** Set while the org has the pass removed from Wallet, with its note. */
  removal: { message: string | null } | null;
}

export interface PassImage {
  name: string;
  /** Under `/p/:token/assets/`, cache-busted by content hash. */
  path: string;
  /** Pixels, when recorded. */
  width: number | null;
  height: number | null;
}

/**
 * The pass's images for the pass page and the pass email: its overrides, then the template's for
 * the slots they leave (an override replaces every scale of its slot, as in the signed pass).
 */
export async function passImages(ctx: ServiceContext, pass: Pass): Promise<PassImage[]> {
  const snapshot = await capturePassSnapshot(ctx, pass);
  const [template, originalOverrides, org, photo] = await Promise.all([
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    listAssets(ctx.env.DB, pass.id),
    getOrg(ctx.env.DB, pass.orgId),
    memberPhotoAsset(ctx.env.DB, pass.orgId, pass.id),
  ]);
  const passOverrides = photo
    ? [...originalOverrides.filter((a) => !/^thumbnail(?:@[23]x)?\.png$/.test(a.name)), photo]
    : originalOverrides;
  const branded = await brandingFiles(
    ctx.env.BUCKET,
    pass.orgId,
    readBranding(org?.branding).images,
  );
  const own = replacedBy(passOverrides.map((a) => a.name));
  const orgFiles = branded.filter((f) => !own(f.name));
  const taken = replacedBy([...passOverrides, ...orgFiles].map((a) => a.name));
  const image = (
    a: { name: string; width?: number | null; height?: number | null },
    version: string,
  ): PassImage => ({
    name: a.name,
    path: `/p/${pass.downloadToken}/assets/${a.name}?v=${version}`,
    width: a.width ?? null,
    height: a.height ?? null,
  });
  const images = [
    ...template.assets
      .filter((a) => a.name.endsWith('.png') && !taken(a.name))
      .map((a) => image(a, a.sha1 || template.version)),
    ...orgFiles.map((f) => image(f, f.version)),
    ...passOverrides.map((a) => image(a, a.sha1)),
  ];
  await assertPassSnapshot(ctx, snapshot);
  return images;
}

export async function pageModel(ctx: ServiceContext, pass: Pass): Promise<PublicPageModel> {
  const raw = await passJsonAtVersion(ctx.env.DB, pass.id, pass.version);
  if (!raw) throw new NotFoundError('The pass has no stored version.', 'PASS_VERSION_MISSING');
  const [images, org, removal] = await Promise.all([
    passImages(ctx, pass),
    getOrg(ctx.env.DB, pass.orgId),
    pass.removedAt !== null ? getRemoval(ctx.env.DB, pass.id) : null,
  ]);
  const assets = Object.fromEntries(images.map((i) => [i.name, i.path]));
  const passJson = parseStoredPassJson(raw);
  if (!canPresent(pass, passJson, ctx.clock.now())) {
    delete passJson.barcode;
    delete passJson.barcodes;
  }
  return {
    passJson,
    assets,
    orgName: org?.name ?? '',
    removal: pass.removedAt !== null ? { message: removal?.message?.trim() || null } : null,
  };
}

export interface PublicAsset {
  body: ReadableStream<Uint8Array>;
  etag: string;
  /** True when the returned bytes are an included member photo rather than a normal asset. */
  memberPhoto?: true;
}

/** Per-pass override, then the org's uploaded logo or icon, then the template's image of the same name. */
export async function openPublicAsset(
  ctx: ServiceContext,
  pass: Pass,
  name: string,
): Promise<PublicAsset> {
  if (!ASSET_NAME.test(name)) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  const photo =
    name === 'thumbnail@3x.png' ? await memberPhotoAsset(ctx.env.DB, pass.orgId, pass.id) : null;
  if (photo) {
    const object = await ctx.env.BUCKET.get(photo.r2Key);
    if (!object) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    try {
      const current = await memberPhotoAsset(ctx.env.DB, pass.orgId, pass.id);
      if (!current || current.r2Key !== photo.r2Key || current.sha1 !== photo.sha1) {
        throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
      }
    } catch (error) {
      await object.body.cancel();
      throw error;
    }
    return { body: object.body, etag: `"${photo.sha1}"`, memberPhoto: true };
  }
  const override = await getPassAsset(ctx.env.DB, pass.id, name);
  if (override) {
    const object = await ctx.env.BUCKET.get(override.r2Key);
    if (!object) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    try {
      const current = await getPassAsset(ctx.env.DB, pass.id, name);
      if (!current || current.r2Key !== override.r2Key || current.sha1 !== override.sha1) {
        throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
      }
    } catch (error) {
      await object.body.cancel();
      throw error;
    }
    return { body: object.body, etag: `"${override.sha1}"` };
  }
  const org = await getOrg(ctx.env.DB, pass.orgId);
  const file = (
    await brandingFiles(ctx.env.BUCKET, pass.orgId, readBranding(org?.branding).images)
  ).find((f) => f.name === name);
  if (file) {
    const object = await ctx.env.BUCKET.get(file.r2Key);
    if (!object) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    return { body: object.body, etag: `"${file.version}-${name}"` };
  }
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const entry = template.assets.find((a) => a.name === name);
  if (!entry) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  return {
    body: await depsOf(ctx.env).registry.openAsset(template, name),
    etag: `"${entry.sha1 || `${template.version}-${name}`}"`,
  };
}
