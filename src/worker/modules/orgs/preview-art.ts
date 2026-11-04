import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import {
  type PassEmailImages,
  type PassImageRef,
  passEmailImages,
} from '../../email/pass-images.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { replacedBy } from '../passes/assets.ts';
import type { TenantBranding } from '../passes/branding.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { syncBakedTemplates } from '../templates/sync.ts';
import { brandingFiles } from './branding-files.ts';
import { previewTemplateId } from './repo-preview.ts';

/** An org with no template and no passes starts from the generic starter. */
export const PREVIEW_STARTER_ID = 'baked:starter-generic';

/** The template behind the preview: the one the org's passes use most, else its first, else the starter. */
export async function previewTemplate(ctx: ServiceContext, orgId: string) {
  // Baked templates reach D1 on first use; the query below reads D1.
  await syncBakedTemplates(ctx);
  const id = (await previewTemplateId(ctx.env.DB, orgId)) ?? PREVIEW_STARTER_ID;
  return resolveTemplate(ctx, orgId, id);
}

/**
 * The icon and logo the org's passes carry, as on the pass page: the org's uploads, else the
 * template's. Admin routes on `origin` serve them (the preview frame has the admin session); a
 * holder's capability URL never appears.
 */
export async function previewImages(
  ctx: ServiceContext,
  orgId: string,
  branding: TenantBranding,
  template: ResolvedTemplate,
  origin: string,
): Promise<PassEmailImages> {
  const uploads = await brandingFiles(ctx.env.BUCKET, orgId, branding.images);
  const taken = replacedBy(uploads.map((f) => f.name));
  const base = `/api/v1/templates/${encodeURIComponent(template.id)}/versions/${encodeURIComponent(template.version)}/assets`;
  const images: PassImageRef[] = [
    ...template.assets
      .filter((a) => a.name.endsWith('.png') && !taken(a.name))
      .map((a) => ({
        name: a.name,
        path: `${base}/${a.name}`,
        width: a.width ?? null,
        height: a.height ?? null,
      })),
    ...uploads.map((f) => ({
      name: f.name,
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/branding/${f.slot}/${f.name.includes('@3x') ? '3x' : '2x'}?v=${f.version}`,
      width: f.width,
      height: f.height,
    })),
  ];
  return passEmailImages(images, origin);
}
