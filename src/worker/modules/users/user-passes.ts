import type { z } from 'zod';
import type { Channel } from '../../../shared/contracts/channels.ts';
import type { UserPassesQuerySchema, UserPassListSchema } from '../../../shared/contracts/users.ts';
import { resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { listUserPasses } from './repo-user-passes.ts';
import { requireUser } from './service.ts';

type Page = z.infer<typeof UserPassListSchema>;

/**
 * A person's passes in every organization, for a platform admin. Holder personalization, titles
 * and capability URLs are not read at all. The read is audited with the count only.
 */
export async function listPassesOfUser(
  ctx: ServiceContext,
  actorId: string,
  userId: string,
  query: z.infer<typeof UserPassesQuerySchema>,
): Promise<Page> {
  await requireUser(ctx, userId);
  const rows = await listUserPasses(ctx.env.DB, userId, query.cursor, query.limit + 1);
  const page = rows.slice(0, query.limit);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'platform.user_passes_read',
    targetType: 'user',
    targetId: userId,
    detail: { count: page.length },
  });
  return {
    items: page.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      orgStatus: r.org_status,
      timeZone: resolveOrgTimeZone(r.time_zone),
      templateName: r.template_name,
      status: r.status,
      channels: (
        [
          [r.has_apple, 'apple'],
          [r.has_google, 'google'],
          [r.has_samsung, 'samsung'],
        ] as const
      ).flatMap(([on, channel]): Channel[] => (on ? [channel] : [])),
      issuedAt: r.created_at,
      updatedAt: r.modified_at,
    })),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
