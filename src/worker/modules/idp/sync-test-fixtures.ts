import { env } from 'cloudflare:workers';
import {
  createFakeIdp,
  type FakeIdp,
  type FakeIdpOptions,
  installFakeIdp,
} from '../../../../test/helpers/fake-idp.ts';
import type { Fixtures } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';
import type { Person } from './access-test-fixtures.ts';
import { clearMarks, db, person, world } from './access-test-fixtures.ts';
import type { TargetStateRow } from './repo-state.ts';
import { statesOfSubject } from './repo-state.ts';
import type { Target } from './types.ts';

export interface Rig {
  f: Fixtures;
  fake: FakeIdp;
  ctx: ServiceContext;
  /** Parsed log lines, oldest first. */
  logs: Record<string, unknown>[];
}

/** A world, a fake Polaris ID on its env, and a job context whose log is captured. */
export async function rig(options: FakeIdpOptions = {}): Promise<Rig> {
  const f = await world();
  const fake = createFakeIdp({ now: () => f.clock.now(), ...options });
  installFakeIdp(f.env, fake);
  const logs: Record<string, unknown>[] = [];
  const log = createLogger(
    {},
    { level: 'debug', sink: (line) => void logs.push(JSON.parse(line)) },
  );
  const ctx = createJobContext(f.env, 'idp.test', { clock: f.clock, log });
  return { f, fake, ctx, logs };
}

/** A linked person whose queued marks are cleared, so a test drains only what it sets up. */
export async function quietPerson(
  r: Rig,
  opts: Parameters<typeof person>[1] = {},
): Promise<Person> {
  const p = await person(r.f, opts);
  await clearMarks([p.subject]);
  return p;
}

/** Seeds the account PassBook added `targets` on (a role and its grant), as the binding records them. */
export function passbookAdded(
  r: Rig,
  subject: string,
  targets: Target[],
  init: { class?: 'created' | 'linked' } = {},
): void {
  r.fake.addAccount(subject, { class: init.class ?? 'linked' });
  const a = r.fake.accounts.get(subject);
  for (const t of targets) {
    a?.roles.add(t);
    a?.grants.add(t);
  }
}

/** The owner removes a role in Polaris ID. */
export const ownerRemoves = (r: Rig, subject: string, target: Target): void => {
  r.fake.accounts.get(subject)?.roles.delete(target);
};

export const stateRows = (subject: string): Promise<TargetStateRow[]> =>
  statesOfSubject(db(), subject);

export const auditActions = async (userId: string): Promise<string[]> =>
  (
    await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'idp.%' ORDER BY id",
      [userId],
    )
  ).map((r) => r.action);

export const driftKinds = async (subject: string): Promise<string[]> =>
  (
    await all<{ kind: string; target: string }>(
      env.DB,
      'SELECT kind, target FROM idp_drift WHERE subject = ? AND resolved_at IS NULL ORDER BY kind, target',
      [subject],
    )
  ).map((r) => `${r.kind}:${r.target}`);

/** A session row of a user: `oidc` is Polaris ID, `magic_link` an email link. */
export async function session(
  r: Rig,
  userId: string,
  roles: string[],
  amr: 'oidc' | 'magic_link' = 'oidc',
): Promise<string> {
  const id = r.f.ids.id();
  const now = r.f.clock.now();
  await run(
    env.DB,
    `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
     VALUES (?, ?, ?, ?, 'csrf', ?, ?, ?, ?)`,
    [id, userId, amr, JSON.stringify(roles), now, now, now + 3_600_000, now + 43_200_000],
  );
  return id;
}

/** Ids of the user's sessions that are still live. */
export async function liveSessions(userId: string): Promise<string[]> {
  const rows = await all<{ id_hash: string }>(
    env.DB,
    'SELECT id_hash FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY id_hash',
    [userId],
  );
  return rows.map((x) => x.id_hash);
}

export async function dirtyRow(subject: string) {
  return first<{ version: number; attempts: number; next_at: number }>(
    env.DB,
    'SELECT version, attempts, next_at FROM idp_dirty WHERE subject = ?',
    [subject],
  );
}

export const calls = (fake: FakeIdp, method: string): number =>
  fake.log.filter((m) => m === method).length;
