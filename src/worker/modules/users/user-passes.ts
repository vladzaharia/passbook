import type { z } from 'zod';
import type { Channel } from '../../../shared/contracts/channels.ts';
import type { UserPassesQuerySchema, UserPassListSchema } from '../../../shared/contracts/users.ts';
import { resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import { callerActor, type PlatformCaller } from '../../platform/actor.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { viewerOrgName } from '../orgs/personal-names.ts';
import { branchIds, MAX_EMAILS, passesByIds, verifiedEmails } from './repo-user-passes.ts';
import { requireUser } from './service.ts';

type Page = z.infer<typeof UserPassListSchema>;

/**
 * A person's passes in every organization, for a platform admin. Holder personalization, titles
 * and capability URLs are not read at all. The read is audited with the count only.
 */
export async function listPassesOfUser(
  ctx: ServiceContext,
  who: PlatformCaller,
  userId: string,
  query: z.infer<typeof UserPassesQuerySchema>,
): Promise<Page> {
  await requireUser(ctx, userId);
  // The viewer of a personal org is a person: a key sees none of them as its own.
  const actorId = who.userId ?? '';
  const db = ctx.env.DB;
  const cursor = query.cursor ?? '~';
  const want = query.limit + 1;
  const found = await verifiedEmails(db, userId);
  if (found.length > MAX_EMAILS)
    ctx.log.warn('users.passes_email_cap', { code: 'USER_PASSES_EMAIL_CAP', userId });
  const emails = found.slice(0, MAX_EMAILS);
  // Each branch's newest `want` hold the newest `want` overall; at most (1 + emails) x want ids.
  const branches = await Promise.all([
    branchIds(db, 'owner', userId, cursor, want, actorId),
    ...emails.map((email) => branchIds(db, 'waiting', email, cursor, want, actorId)),
  ]);
  // A capped branch is complete only above where it stopped; the page ends there and the cursor
  // resumes from it.
  const floor = branches.reduce<string | null>(
    (low, b) => (b.scannedTo && (!low || b.scannedTo > low) ? b.scannedTo : low),
    null,
  );
  const all = [...new Set(branches.flatMap((b) => b.ids))].sort().reverse();
  const ids = (floor ? all.filter((id) => id > floor) : all).slice(0, want);
  const more = ids.length > query.limit;
  const rows = ids.length ? await passesByIds(db, ids) : [];
  const page = rows.slice(0, query.limit);
  const actor = callerActor(who);
  await recordAudit(ctx, {
    actorType: actor.type,
    actorId: actor.id,
    action: 'platform.user_passes_read',
    targetType: 'user',
    targetId: userId,
    detail: { count: page.length },
  });
  return {
    items: page.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: viewerOrgName(r, actorId),
      orgStatus: r.org_status,
      timeZone: resolveOrgTimeZone(r.time_zone),
      templateName: r.template_name,
      status: r.status,
      holding: r.owned ? ('owned' as const) : ('waiting' as const),
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
    nextCursor: more ? (page.at(-1)?.id ?? null) : floor,
  };
}
