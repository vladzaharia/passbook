import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import type { Pass } from './repo.ts';
import { listAssets } from './repo-history-assets.ts';
import type { MemberPhotoRow } from './repo-member-photo.ts';

export async function memberPhotoWalletSupported(ctx: ServiceContext, pass: Pass) {
  const [template, overrides] = await Promise.all([
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    listAssets(ctx.env.DB, pass.id),
  ]);
  return (
    'generic' in template.passJson ||
    ('eventTicket' in template.passJson &&
      !template.assets.some((a) => a.slot === 'strip') &&
      !overrides.some((a) => /^strip(?:@[23]x)?\.png$/.test(a.name)))
  );
}

export async function memberPhotoDto(
  ctx: ServiceContext,
  pass: Pass,
  photo: MemberPhotoRow | null,
) {
  return {
    passId: pass.id,
    orgId: pass.orgId,
    url: photo ? `/api/v1/passes/${pass.id}/member-photo/image?v=${photo.version}` : null,
    includeInPass: photo?.include_in_pass === 1,
    walletSupported: await memberPhotoWalletSupported(ctx, pass),
    updatedAt: photo?.updated_at ?? null,
  };
}
