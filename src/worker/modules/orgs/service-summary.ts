import type { z } from 'zod';
import type { OrgSummarySchema, PlatformOrgSummarySchema } from '../../../shared/contracts/orgs.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from './org-dto.ts';
import { COUNT_CAP, type OrgRow } from './repo.ts';
import { personalOwners } from './repo-personal.ts';

type Platform = z.infer<typeof PlatformOrgSummarySchema>;
/** The summary, with the platform-only fields when a platform view asks for them. */
export type Summary = z.infer<typeof OrgSummarySchema> & Partial<Pick<Platform, 'plan'>>;

/** Names of the owners of the personal orgs among `rows`: for platform views only. */
export const ownersOf = async (ctx: ServiceContext, rows: OrgRow[]) =>
  personalOwners(
    ctx.env.DB,
    rows.flatMap((r) => (r.personal_user_id ? [r.personal_user_id] : [])),
  );

export function summarize(
  row: OrgRow,
  counts?: Summary['counts'],
  owners?: Map<string, string | null>,
  plans?: Map<string, { preset: string; label: string }>,
): Summary {
  const c = counts ?? { passes: 0, templates: 0, connections: 0, apiKeys: 0, members: 0 };
  const owner = row.personal_user_id
    ? { id: row.personal_user_id, name: owners?.get(row.personal_user_id) ?? null }
    : null;
  return {
    ...toDto(row),
    counts: c,
    countsCapped: Object.values(c).some((n) => n >= COUNT_CAP),
    ...(owners && owner ? { personalOwner: owner } : {}),
    ...(plans ? { plan: plans.get(row.id) ?? null } : {}),
  };
}
