import {
  createFakeIdp,
  type FakeIdp,
  installFakeIdp,
} from '../../../../../test/helpers/fake-idp.ts';
import { makeSession, makeUser } from '../../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../../shared/contracts/org-membership.ts';
import { INVITE_PREFIX } from '../../../../shared/invitation-link.ts';
import { all, first, run } from '../../../platform/db.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import * as kit from '../../api-keys/test-kit.ts';
import type { TestHarness } from '../../auth/test-support.ts';

export const DAY = 86_400_000;
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

export interface Rig {
  h: TestHarness;
  idp: FakeIdp;
  orgId: string;
  /** An address made unique to this test: the suite's database outlives one test, and addresses are unique in it. */
  addr(email: string): string;
}

let rigs = 0;

/** The harness, a fake Polaris ID binding behind it, and Turnstile's always-pass secret. Call `kit.teardown` after. */
export async function rig(options: Parameters<typeof createFakeIdp>[0] = {}): Promise<Rig> {
  await kit.setup();
  const tag = `t${++rigs}`;
  const idp = createFakeIdp({ now: () => kit.h.clock.now(), tokenPrefix: tag, ...options });
  installFakeIdp(kit.h.env, idp);
  kit.h.env.TURNSTILE_SECRET = TURNSTILE_TEST_SECRET;
  // Sign-in reads the console group by this name; the fake binding's console group is `passbook_console`.
  kit.h.env.OIDC_ADMIN_GROUP = 'passbook_console';
  return {
    h: kit.h,
    idp,
    orgId: kit.org.id,
    addr: (email) => email.replace('@', `+${tag}@`),
  };
}

export const teardown = kit.teardown;

export interface Invite {
  secret: string;
  id: string;
  /** The paired member invitation of a developer invitation. */
  memberId: string | null;
  email: string;
}

export async function memberInvite(
  r: Rig,
  email: string,
  options: { roles?: OrgRole[]; prefix?: boolean; expiresIn?: number } = {},
): Promise<Invite> {
  const f = kit.f();
  const secret = `${options.prefix === false ? '' : INVITE_PREFIX.member}${f.ids.token(32)}`;
  const id = f.ids.id();
  const now = r.h.clock.now();
  await run(
    r.h.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.orgId,
      r.addr(email),
      JSON.stringify(options.roles ?? ['read_only']),
      await sha256Hex(secret),
      now,
      now + (options.expiresIn ?? 7 * DAY),
    ],
  );
  return { secret, id, memberId: id, email: r.addr(email) };
}

export async function developerInvite(
  r: Rig,
  email: string,
  options: { roles?: OrgRole[]; expiresIn?: number; orgId?: string } = {},
): Promise<Invite> {
  const f = kit.f();
  const orgId = options.orgId ?? r.orgId;
  const secret = `${INVITE_PREFIX.developer}${f.ids.token(32)}`;
  const id = f.ids.id();
  const now = r.h.clock.now();
  const expires = now + (options.expiresIn ?? 7 * DAY);
  let memberId: string | null = null;
  if (options.roles) {
    memberId = f.ids.id();
    await run(
      r.h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        memberId,
        orgId,
        r.addr(email),
        JSON.stringify(options.roles),
        await sha256Hex(f.ids.token(32)),
        now,
        expires,
      ],
    );
  }
  const creator = await makeUser(f);
  await run(
    r.h.env.DB,
    `INSERT INTO developer_invitations (id, org_id, email, token_hash, org_invitation_id, created_by_user, created_at, expires_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      r.addr(email),
      await sha256Hex(secret),
      memberId,
      creator.id,
      now,
      expires,
      expires,
    ],
  );
  return { secret, id, memberId, email: r.addr(email) };
}

/** A person with a Polaris ID session (strong) that holds `email` verified. */
export async function person(
  r: Rig,
  email: string,
  roles: ('admin' | 'user' | 'developer' | 'console')[] = ['user'],
) {
  const f = kit.f();
  const user = await makeUser(f, { primaryEmail: r.addr(email) });
  const session = await makeSession(f, { userId: user.id, roles, lifetimeMs: 30 * DAY });
  const subject = `test-${user.id}`;
  return { user, session, subject };
}

export const post = (r: Rig, path: string, json: object, headers: Record<string, string> = {}) =>
  r.h.call(`/api/v1/invitations${path}`, { method: 'POST', headers, json });

/** A challenged call: the harness's Turnstile stub passes the response `ok`. */
export const challenge = (secret: string) => ({ token: secret, turnstileToken: 'ok' });

export const rowsOf = (r: Rig, sql: string, params: (string | number)[] = []) =>
  all<Record<string, unknown>>(r.h.env.DB, sql, params);
export const oneOf = (r: Rig, sql: string, params: (string | number)[] = []) =>
  first<Record<string, unknown>>(r.h.env.DB, sql, params);
