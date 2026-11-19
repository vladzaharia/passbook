// Shared setup for the credential and enrolment service tests: real clock (the 0112 triggers read the
// database clock), org members, a platform admin and valid provider credentials.
import { env } from 'cloudflare:workers';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type {
  GoogleWalletCredentials,
  SamsungWalletCredentials,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ManualClock, systemClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';

export type Mode = 'live' | 'test';
const kek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

export async function kit() {
  const e = await makeEnv({ KEK_V1: kek, PUBLIC_BASE_URL: 'https://wallet.test' });
  /** Fixtures want a ManualClock; the 0112 triggers read the real one, so this one follows it. */
  class RealClock extends ManualClock {
    override now() {
      return Date.now();
    }
  }
  const f = fixtures(e, new RealClock());
  const identity = await createFixtureIdentity();
  const ctx = createServiceContext(e, { clock: systemClock });

  async function auth(
    userId: string,
    roles: ('admin' | 'user')[],
    mode: Mode,
  ): Promise<SessionAuth> {
    const session = await makeSession(f, { userId, roles });
    return {
      kind: 'session',
      userId,
      sessionId: await sha256Hex(session.cookieValue),
      roles,
      csrfSecret: session.csrf,
      amr: 'oidc',
      mode,
    };
  }

  /** A member of the org (default org_admin) with a live session in `mode`. */
  async function member(orgId: string, mode: Mode = 'test', roles: string[] = ['org_admin']) {
    const user = await makeUser(f);
    const invitationId = f.ids.id();
    const now = systemClock.now();
    await run(
      env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invitationId,
        orgId,
        user.primaryEmail,
        JSON.stringify(roles),
        f.ids.token(),
        now,
        now + 3_600_000,
        now,
      ],
    );
    await run(
      env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [f.ids.id(), orgId, user.id, invitationId, JSON.stringify(roles), now],
    );
    return { user, auth: await auth(user.id, ['user'], mode) };
  }

  /** A platform admin: the admin role and no membership. */
  async function admin(mode: Mode = 'live') {
    const user = await makeUser(f);
    return { user, auth: await auth(user.id, ['admin', 'user'], mode) };
  }

  const google = (issuerId = '123456789'): GoogleWalletCredentials => ({
    issuerId,
    serviceAccountEmail: 'wallet@example-project.iam.gserviceaccount.com',
    privateKeyPem: identity.privateKey,
    scopes: [GOOGLE_WALLET_SCOPE],
  });
  const samsung = (cardId = 'card123'): SamsungWalletCredentials => ({
    partnerId: 'partner123',
    certificateId: 'AB12',
    cardId,
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  });

  return {
    env: e,
    f,
    ctx,
    member,
    admin,
    google,
    samsung,
    org: () => makeOrg(f),
    privateKey: identity.privateKey,
  };
}
export type Kit = Awaited<ReturnType<typeof kit>>;
