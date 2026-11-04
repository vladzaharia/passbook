import type { PassJson } from '../../../passkit/types.ts';
import { safeMail, safeUrl } from '../../email/safe.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgBranding } from '../delivery/repo.ts';
import { isOrgActive } from '../orgs/active.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { replacedBy } from '../passes/assets.ts';
import { readBranding } from '../passes/branding.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { depsOf } from '../passes/deps.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import {
  currentPassJson,
  getOrg,
  getPassByDownloadToken,
  listAssets,
  type Pass,
} from '../passes/repo.ts';
import { getOrgSettings } from '../settings/service.ts';
import { getPassAsset } from './repo.ts';

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const ASSET_NAME = /^[A-Za-z0-9_@.-]{1,100}\.png$/;

export const isTokenShape = (token: string) => TOKEN.test(token);

const notFound = () => new NotFoundError('This link is not valid.', 'LINK_NOT_FOUND');

/** Bearer-link lookup. A rotated token no longer resolves. */
export async function passForToken(ctx: ServiceContext, token: string): Promise<Pass> {
  if (!isTokenShape(token)) throw notFound();
  const pass = await getPassByDownloadToken(ctx.env.DB, token);
  if (!pass || !(await isOrgActive(ctx, pass.orgId))) throw notFound();
  return pass;
}

export interface SupportContacts {
  email: string | null;
  url: string | null;
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
  return {
    email: safeMail(settings['support.email'] ?? branding.supportEmail),
    url: safeUrl(settings['support.url'] ?? branding.supportUrl),
  };
}

export interface PublicPageModel {
  passJson: PassJson;
  /** The org's name, when the pass names none. */
  orgName: string;
  /** Asset name -> URL, cache-busted by content hash so the response can be immutable. */
  assets: Record<string, string>;
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
  const [template, passOverrides, org] = await Promise.all([
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    listAssets(ctx.env.DB, pass.id),
    getOrg(ctx.env.DB, pass.orgId),
  ]);
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
  return [
    ...template.assets
      .filter((a) => a.name.endsWith('.png') && !taken(a.name))
      .map((a) => image(a, a.sha1 || template.version)),
    ...orgFiles.map((f) => image(f, f.version)),
    ...passOverrides.map((a) => image(a, a.sha1)),
  ];
}

export async function pageModel(ctx: ServiceContext, pass: Pass): Promise<PublicPageModel> {
  const raw = await currentPassJson(ctx.env.DB, pass.id);
  if (!raw) throw new NotFoundError('The pass has no stored version.', 'PASS_VERSION_MISSING');
  const [images, org] = await Promise.all([passImages(ctx, pass), getOrg(ctx.env.DB, pass.orgId)]);
  const assets = Object.fromEntries(images.map((i) => [i.name, i.path]));
  return { passJson: parseStoredPassJson(raw), assets, orgName: org?.name ?? '' };
}

export interface PublicAsset {
  body: ReadableStream<Uint8Array>;
  etag: string;
}

/** Per-pass override, then the org's uploaded logo or icon, then the template's image of the same name. */
export async function openPublicAsset(
  ctx: ServiceContext,
  pass: Pass,
  name: string,
): Promise<PublicAsset> {
  if (!ASSET_NAME.test(name)) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  const override = await getPassAsset(ctx.env.DB, pass.id, name);
  if (override) {
    const object = await ctx.env.BUCKET.get(override.r2Key);
    if (!object) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
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
