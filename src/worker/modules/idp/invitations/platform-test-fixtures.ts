import { makeSession, makeUser } from '../../../../../test/helpers/index.ts';
import { INVITE_PREFIX } from '../../../../shared/invitation-link.ts';
import { run } from '../../../platform/db.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import { f } from '../../api-keys/test-kit.ts';
import { DAY, type Rig } from './invitations-test-fixtures.ts';

let groups = 0;

/** A custom group in both places that hold it: PassBook's table and the fake Polaris ID. Keys are unique per call. */
export async function customGroup(r: Rig, label = 'g'): Promise<string> {
  const key = `${label}${++groups}_${r.h.clock.now() % 100_000}`;
  await run(
    r.h.env.DB,
    "INSERT INTO idp_groups (key, kind, friendly_name, created_at) VALUES (?, 'custom', ?, ?)",
    [key, `Group ${key}`, r.h.clock.now()],
  );
  await r.idp.createGroup(key, `Group ${key}`, {
    ref: 'test',
    reason: 'test',
    actor: { kind: 'system', job: 'test' },
  });
  return key;
}

/** A platform admin signed in with Polaris ID: the admin routes' caller. */
export async function admin(): Promise<{ id: string; headers: Record<string, string> }> {
  const user = await makeUser(f());
  const session = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return { id: user.id, headers: session.headers };
}

export interface Seeded {
  secret: string;
  id: string;
  email: string;
}

/** A platform invitation row, as the service writes it. */
export async function platformInvite(
  r: Rig,
  email: string,
  options: { groups?: string[]; developer?: boolean; expiresIn?: number } = {},
): Promise<Seeded> {
  const creator = await admin();
  const secret = `${INVITE_PREFIX.platform}${f().ids.token(32)}`;
  const id = f().ids.id();
  const now = r.h.clock.now();
  const expires = now + (options.expiresIn ?? 7 * DAY);
  await run(
    r.h.env.DB,
    `INSERT INTO platform_invitations (id, email, token_hash, groups, developer, created_by_user, created_at, expires_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.addr(email),
      await sha256Hex(secret),
      JSON.stringify(options.groups ?? []),
      options.developer ? 1 : 0,
      creator.id,
      now,
      expires,
      expires + DAY,
    ],
  );
  return { secret, id, email: r.addr(email) };
}
