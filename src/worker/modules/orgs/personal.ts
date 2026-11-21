import { classifyD1Error } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { personalOrgName, personalOrgSlug } from './personal-names.ts';
import { slugTaken } from './repo.ts';
import type { OrgAdmin } from './repo-org-writes.ts';
import { getPersonalUser, insertPersonalOrg, personalOrgIdOf } from './repo-personal.ts';

const ATTEMPTS = 8;

/**
 * Gives the signed-in platform admin their one personal org. Idempotent and race-safe: the unique
 * marker makes a concurrent ensure fail its insert, and the loser finds the winner's org. A closed
 * personal org still counts, so it is not recreated. Never throws: sign-in goes on without it.
 */
export async function ensurePersonalOrg(ctx: ServiceContext, admin: OrgAdmin): Promise<void> {
  try {
    const db = ctx.env.DB;
    if (await personalOrgIdOf(db, admin.userId)) return;
    const user = await getPersonalUser(db, admin.userId);
    if (user?.status !== 'active') return;
    const name = personalOrgName(user);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const slug = personalOrgSlug(name, user.id, attempt);
      if (await slugTaken(db, slug)) continue;
      try {
        await insertPersonalOrg(
          ctx,
          {
            orgId: ctx.ids.id(),
            slug,
            name,
            userId: user.id,
            email: user.primary_email,
            invitationId: ctx.ids.id(),
            membershipId: ctx.ids.id(),
            tokenHash: await sha256Hex(ctx.ids.token(32)),
            now: ctx.clock.now(),
          },
          admin,
        );
        return;
      } catch (error) {
        // Another sign-in made the org first, or took this slug: look again, then try the next slug.
        if (await personalOrgIdOf(db, user.id)) return;
        if (classifyD1Error(error)?.kind !== 'unique') throw error;
      }
    }
    ctx.log.error('org.personal_ensure_failed', { code: 'PERSONAL_ORG_SLUG_EXHAUSTED' });
  } catch (error) {
    ctx.log.error('org.personal_ensure_failed', {
      code: 'PERSONAL_ORG_ENSURE_FAILED',
      kind: classifyD1Error(error)?.kind ?? 'other',
    });
  }
}
