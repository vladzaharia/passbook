import type { z } from 'zod';
import type { OrgBrandingSchema, OrgDto } from '../../../shared/contracts/orgs.ts';
import type { OrgRow } from './repo.ts';

type Branding = z.infer<typeof OrgBrandingSchema>;

export function toDto(row: OrgRow): OrgDto {
  const { logo, icon, web, ...branding } = JSON.parse(row.branding) as Branding;
  const image = (value: NonNullable<Branding['logo']>) => ({
    sha: value.sha,
    w: value.w,
    h: value.h,
  });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    defaultIdentityId: row.default_identity_id,
    branding: {
      ...branding,
      ...(logo ? { logo: image(logo) } : {}),
      ...(icon ? { icon: image(icon) } : {}),
      ...(web ? { web: image(web) } : {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    configRevision: row.config_revision,
    personal: row.personal_user_id !== null,
    kind: row.kind,
  };
}
