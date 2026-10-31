import type { PassJson } from '../../../passkit/types.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { depsOf } from '../passes/deps.ts';
import { currentPassJson, getPassByDownloadToken, listAssets, type Pass } from '../passes/repo.ts';
import { getPassAsset } from './repo.ts';

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const ASSET_NAME = /^[A-Za-z0-9_@.-]{1,100}\.png$/;

const notFound = () => new NotFoundError('This link is not valid.', 'LINK_NOT_FOUND');

/** Bearer-link lookup. A rotated token no longer resolves. */
export async function passForToken(ctx: ServiceContext, token: string): Promise<Pass> {
  if (!TOKEN.test(token)) throw notFound();
  const pass = await getPassByDownloadToken(ctx.env.DB, token);
  if (!pass) throw notFound();
  return pass;
}

export interface PublicPageModel {
  passJson: PassJson;
  /** Asset name -> URL, cache-busted by content hash so the response can be immutable. */
  assets: Record<string, string>;
}

export async function pageModel(ctx: ServiceContext, pass: Pass): Promise<PublicPageModel> {
  const raw = await currentPassJson(ctx.env.DB, pass.id);
  if (!raw) throw new NotFoundError('The pass has no stored version.', 'PASS_VERSION_MISSING');
  const base = `/p/${pass.downloadToken}/assets/`;
  const assets: Record<string, string> = {};
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  for (const a of template.assets) {
    if (a.name.endsWith('.png'))
      assets[a.name] = `${base}${a.name}?v=${a.sha1 || template.version}`;
  }
  for (const a of await listAssets(ctx.env.DB, pass.id))
    assets[a.name] = `${base}${a.name}?v=${a.sha1}`;
  return { passJson: JSON.parse(raw) as PassJson, assets };
}

export interface PublicAsset {
  body: ReadableStream<Uint8Array>;
  etag: string;
}

/** Per-pass override first, then the template's image of the same name. */
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
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const entry = template.assets.find((a) => a.name === name);
  if (!entry) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  return {
    body: await depsOf(ctx.env).registry.openAsset(template, name),
    etag: `"${entry.sha1 || `${template.version}-${name}`}"`,
  };
}
