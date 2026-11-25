import { bindPass } from '../../../passkit/template/bindings.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization } from '../../../passkit/types.ts';
import { type LayoutView, normalize, type PassView } from '../../../shared/pass-view/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { appliedBranding, readBranding, tenantPassJson } from '../passes/branding.ts';
import { depsOf } from '../passes/deps.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import type { OpenRelease } from './issue.ts';
import type { PublicLink } from './repo-issues.ts';

const IMAGE = /^[A-Za-z0-9_@.-]{1,100}\.png$/;
const SLOT = /^([a-zA-Z]+)(?:@[23]x)?\.png$/;
/** Placeholder for each input the card makes for itself; the preview never shows it. */
const GENERATED = '0000000000';

const filled = <T extends { text: string }>(fields: T[]) =>
  fields.filter((f) => f.text.trim() !== '');

function layoutFilled(layout: LayoutView): LayoutView {
  return {
    ...layout,
    header: filled(layout.header),
    primary: filled(layout.primary),
    secondary: filled(layout.secondary),
    auxiliary: layout.auxiliary.map(filled),
    footer: filled(layout.footer),
  };
}

/** Nothing is typed yet: a field with no value (the holder's name) would read as broken, so it is left out. */
export function hideEmpty(view: PassView): PassView {
  const layouts = { ...view.layouts };
  for (const target of Object.keys(layouts) as (keyof typeof layouts)[])
    layouts[target] = layoutFilled(layouts[target]);
  return { ...view, layout: layoutFilled(view.layout), layouts };
}

/** Where the page loads a preview image from: only an open link serves them. */
export const previewPath = (token: string, name: string, version: string) =>
  `/j/${token}/card/${name}?v=${encodeURIComponent(version)}`;

/**
 * The card as a visitor will get it, before they type anything: schema defaults, no name, no
 * barcode and no back. Nothing here is a pass; it holds no pass link, code or holder value.
 */
export async function joinPreview(
  ctx: ServiceContext,
  link: PublicLink,
  open: OpenRelease,
  token: string,
  view: { locale: string; timeZone: string },
): Promise<PassView> {
  const { template, readiness } = open;
  const org = await getOrg(ctx.env.DB, link.orgId);
  const branding = appliedBranding(readBranding(org?.branding), template.manifest);
  const input: Personalization = applyDefaults(template.manifest, {});
  for (const g of readiness.generated) input[g.key] = GENERATED;
  const tenant = {
    ...template,
    passJson: tenantPassJson(template.passJson, link.orgName, branding, org?.personal === true),
  };
  const { pass, droppedImages } = bindPass(tenant, input, {});
  delete pass.barcode;
  delete pass.barcodes;
  const files = await brandingFiles(ctx.env.BUCKET, link.orgId, branding.images);
  const branded = new Set(files.map((f) => f.name));
  const assets: Record<string, string> = {};
  for (const a of template.assets) {
    if (!IMAGE.test(a.name) || branded.has(a.name)) continue;
    const slot = SLOT.exec(a.name)?.[1];
    if (slot && droppedImages.includes(slot)) continue;
    assets[a.name] = previewPath(token, a.name, a.sha1 || template.version);
  }
  for (const f of files) assets[f.name] = previewPath(token, f.name, f.version);
  const card = normalize(pass, {
    assets,
    locale: view.locale,
    timeZone: view.timeZone,
    showZone: true,
    now: new Date(ctx.clock.now()),
  });
  return hideEmpty(card);
}

export interface PreviewImage {
  body: ReadableStream<Uint8Array>;
  etag: string;
}

/** One image of the open release: the org's own logo or icon, else the template's file of that name. */
export async function previewImage(
  ctx: ServiceContext,
  link: PublicLink,
  open: OpenRelease,
  name: string,
): Promise<PreviewImage> {
  if (!IMAGE.test(name)) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  const org = await getOrg(ctx.env.DB, link.orgId);
  const own = (
    await brandingFiles(
      ctx.env.BUCKET,
      link.orgId,
      appliedBranding(readBranding(org?.branding), open.template.manifest).images,
    )
  ).find((f) => f.name === name);
  if (own) {
    const object = await ctx.env.BUCKET.get(own.r2Key);
    if (!object) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    return { body: object.body, etag: `"${own.version}-${name}"` };
  }
  const entry = open.template.assets.find((a) => a.name === name);
  if (!entry) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  return {
    body: await depsOf(ctx.env).registry.openAsset(open.template, name),
    etag: `"${entry.sha1 || `${open.template.version}-${name}`}"`,
  };
}
