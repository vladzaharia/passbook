import { makeSession, type SessionFixture } from '../../../../test/helpers/index.ts';
import type { OrgCapability, OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { findInboxCapture, insertInboxMembership } from './repo-test-tenant-fixtures.ts';

export type InboxMember = { membershipId: string; session: SessionFixture };

export async function grantInboxMembership(
  kit: Kit,
  userId: string,
  orgId = kit.org.id,
  role: OrgRole = 'org_admin',
): Promise<string> {
  const invitationId = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  const now = kit.clock.now();
  await insertInboxMembership(
    kit,
    userId,
    orgId,
    role,
    invitationId,
    membershipId,
    kit.fx.ids.token(),
    now,
  );
  return membershipId;
}

export async function inboxMember(
  kit: Kit,
  userId: string,
  orgId = kit.org.id,
  role: OrgRole = 'org_admin',
  roles: ('admin' | 'user')[] = ['user'],
): Promise<InboxMember> {
  const membershipId = await grantInboxMembership(kit, userId, orgId, role);
  const session = await makeSession(kit.fx, { userId, roles });
  return { membershipId, session };
}

export async function captureInboxPass(kit: Kit, orgId = kit.org.id) {
  const recipient = `${kit.fx.ids.token(10).toLowerCase()}@example.com`;
  const pass = await kit.pass({
    orgId,
    mode: 'test',
    memberName: 'Tenant test inbox',
    holderEmail: recipient,
  });
  const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to: recipient,
    attach: false,
    expected: pass,
  });
  await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
  const capture = await findInboxCapture(kit, outboxId);
  if (!capture) throw new Error('Inbox capture missing');
  return { ...capture, pass, recipient };
}

export function inboxApp(kit: Kit) {
  return createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
}

export async function inboxAuthority(
  kit: Kit,
  session: SessionFixture,
  capability: OrgCapability = 'passes:operate',
  orgId = kit.org.id,
) {
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Inbox session did not resolve');
  const authority = await tenantAuthorityOf(kit.ctx, { ...auth, mode: 'test' }, orgId, capability);
  if (authority.kind !== 'session') throw new Error('Expected session authority');
  return authority;
}

export function inboxHeaders(session: SessionFixture): Record<string, string> {
  return { ...session.headers, 'x-passbook-mode': 'test' };
}

export function scopedInboxPath(path: string, orgId: string): string {
  const url = new URL(path, 'https://wallet.test');
  if (!url.searchParams.has('orgId')) url.searchParams.set('orgId', orgId);
  if (url.pathname.endsWith('/html') && !url.searchParams.has('mode'))
    url.searchParams.set('mode', 'test');
  return `${url.pathname}${url.search}`;
}
