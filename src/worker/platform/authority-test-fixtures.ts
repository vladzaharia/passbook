import { env } from 'cloudflare:workers';
import {
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../test/helpers/index.ts';
import type { Principal } from './authority-principal.ts';
import { run } from './db.ts';
import { createJobContext, type ServiceContext } from './service-context.ts';

/** One org with a row of every authority-relevant kind, for immutability and grant tests. */
export async function seedAuthority(label: string) {
  const f = fixtures(await makeEnv());
  const db = env.DB;
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const admin = await makeUser(f);
  const template = makeTemplate({ id: `tpl-${label}` });
  const pass = await makePass(f, { orgId: org.id, template: template.resolved });
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = f.clock.now();
  await run(
    db,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, '["org_admin"]', ?, ?, ?, ?)`,
    [invitationId, org.id, user.primaryEmail, f.ids.token(), now, now + 3600_000, now],
  );
  await run(
    db,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
    [membershipId, org.id, user.id, invitationId, now],
  );
  const session = await makeSession(f, { userId: user.id, roles: ['user'] });
  const adminSession = await makeSession(f, { userId: admin.id, roles: ['admin', 'user'] });
  const key = await makeApiKey(f, { orgId: org.id });
  const staff = await makeScanStaff(f, { orgId: org.id });
  const event = await makeScanEvent(f, { orgId: org.id });
  const scanner = await makeScanner(f, { orgId: org.id });
  const scannerRow = await db
    .prepare('SELECT id, credential_epoch FROM scanners WHERE org_id = ?')
    .bind(org.id)
    .first<{ id: string; credential_epoch: number }>();
  const sessionId = f.ids.id();
  await run(
    db,
    "INSERT INTO scanning_sessions (id, org_id, mode, name, settings, time_zone, created_at, updated_at) VALUES (?, ?, 'live', 'S', '{}', 'UTC', 1, 1)",
    [sessionId, org.id],
  );
  const connectionId = f.ids.id();
  await run(
    db,
    "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'C', 1, 1)",
    [connectionId, org.id],
  );
  return {
    f,
    org,
    user,
    admin,
    pass,
    template,
    membershipId,
    invitationId,
    session,
    adminSession,
    key,
    staff,
    event,
    scanner,
    scannerId: scannerRow?.id ?? '',
    scanningSessionId: sessionId,
    connectionId,
  };
}

/** A seeded org, a job context (can mint `system:` grants), a route context (cannot) and a membership principal. */
export async function setupGrant(label: string) {
  const s = await seedAuthority(label);
  const ctx = createJobContext(s.f.env, 'test', { clock: s.f.clock });
  /** What a route holds: the same context without the job brand. */
  const route: ServiceContext = { ...ctx };
  delete route.job;
  /** A synchronous request when a session hash is given, deferred work (org revision 1) otherwise. */
  const member = (extra: Record<string, unknown> = {}): Principal => {
    const { sessionIdHash, orgAccessRevision, ...rest } = extra;
    const base = { kind: 'membership', membershipId: s.membershipId, mode: 'live', ...rest };
    return (
      sessionIdHash
        ? { ...base, via: 'session', sessionIdHash, orgAccessRevision }
        : {
            userAccessRevision: 1,
            ...base,
            via: 'deferred',
            orgAccessRevision: orgAccessRevision ?? 1,
            allowRequestContext: true,
          }
    ) as Principal;
  };
  return { s, ctx, route, member };
}
