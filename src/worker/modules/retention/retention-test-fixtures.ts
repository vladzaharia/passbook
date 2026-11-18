import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { SettingsAdmin, SettingsAuthority } from '../settings/repo.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface RetentionKit {
  kit: Kit;
  mail: Mail[];
  /** A new org with an admin who can manage it. */
  org(
    roles?: OrgRole[],
  ): Promise<{ orgId: string; email: string; userId: string; authority: SettingsAuthority }>;
  platform(): Promise<SettingsAdmin>;
}

export async function retentionKit(): Promise<RetentionKit> {
  const mail: Mail[] = [];
  const EMAIL = {
    send: async (m: Mail) => {
      mail.push({ to: m.to, subject: m.subject, text: m.text });
      return { messageId: `m-${mail.length}` };
    },
  } as unknown as AppEnv['EMAIL'];
  const kit = await setupKit({ env: { EMAIL } });
  const { fx, env, ctx } = kit;
  const sessionOf = async (userId: string, roles: ('admin' | 'user')[]) => {
    const s = await makeSession(fx, { userId, roles });
    const session = await createSessionStore(env, kit.clock).resolve(s.cookieValue);
    if (!session) throw new Error('Session fixture missing');
    return session;
  };
  return {
    kit,
    mail,
    async org(roles = ['org_admin']) {
      const org = await makeOrg(fx);
      const user = await makeUser(fx);
      const invitationId = fx.ids.id();
      const now = kit.clock.now();
      await run(
        env.DB,
        `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invitationId,
          org.id,
          user.primaryEmail,
          JSON.stringify(roles),
          fx.ids.token(),
          now,
          now + 3_600_000,
          now,
        ],
      );
      await run(
        env.DB,
        `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [fx.ids.id(), org.id, user.id, invitationId, JSON.stringify(roles), now],
      );
      const session = await sessionOf(user.id, ['user']);
      const authority = await tenantAuthorityOf(ctx, session, org.id, 'org:manage');
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      return { orgId: org.id, email: user.primaryEmail, userId: user.id, authority };
    },
    async platform() {
      const user = await makeUser(fx);
      const session = await sessionOf(user.id, ['admin', 'user']);
      return { userId: user.id, sessionId: session.sessionId };
    },
  };
}
