// Raw-SQL seeds for the 0112 schema tests, enrolment side: accounts, events and the steps that move them (see
// repo-wallet-credentials-test-fixtures.ts). Each step is its event and its update in one D1 batch.
import { makePass, makeTemplate, withoutTrigger } from '../../../../test/helpers/index.ts';
import { batch, first, run, type SqlValue, stmt } from '../../platform/db.ts';
import {
  addCheck,
  bytes,
  type Cred,
  currentVersion,
  db,
  ident,
  type Mode,
  type Provider,
  type seedOrg,
  uid,
} from './repo-wallet-credentials-test-fixtures.ts';

export interface Acct {
  id: string;
  orgId: string;
  mode: Mode;
  provider: Provider;
}

export async function enrolment(
  orgId: string,
  mode: Mode = 'live',
  provider: Provider = 'google',
): Promise<Acct> {
  const id = uid();
  await run(
    db(),
    'INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
    [id, orgId, mode, provider],
  );
  return { id, orgId, mode, provider };
}

export const enrolmentRevision = async (a: { id: string }) =>
  (
    await first<{ r: number }>(
      db(),
      'SELECT enrolment_revision AS r FROM wallet_provider_accounts WHERE id = ?',
      [a.id],
    )
  )?.r ?? 0;

export interface EnrolmentEvent {
  kind: 'source' | 'enable' | 'disable' | 'hold' | 'release';
  credentialId?: string | null;
  checkId?: string | null;
  roundTrip?: { kind: 'google_save' | 'samsung_added'; id: string };
  reason?: string | null;
  actorType?: 'user' | 'platform' | 'system';
  createdAt?: number;
  revision?: number;
}

const enrolmentEventStmt = (a: Acct, revision: number, e: EnrolmentEvent) => {
  const actor = e.actorType ?? (e.kind === 'hold' || e.kind === 'release' ? 'platform' : 'user');
  return stmt(
    db(),
    `INSERT INTO wallet_enrolment_events (id, account_id, org_id, mode, provider, enrolment_revision, kind, credential_id,
       check_id, round_trip_kind, round_trip_id, reason, actor_type, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid(),
      a.id,
      a.orgId,
      a.mode,
      a.provider,
      revision,
      e.kind,
      e.credentialId ?? null,
      e.checkId ?? null,
      e.roundTrip?.kind ?? null,
      e.roundTrip?.id ?? null,
      e.reason ?? null,
      actor,
      actor === 'system' ? null : 'u1',
      e.createdAt ?? Date.now(),
    ],
  );
};

/** One event at the account's next enrolment_revision (or the given one). */
export async function insertEnrolmentEvent(a: Acct, e: EnrolmentEvent): Promise<void> {
  await enrolmentEventStmt(a, e.revision ?? (await enrolmentRevision(a)) + 1, e).run();
}

const updateStmt = (a: Acct, set: Record<string, SqlValue>, revision: number) => {
  const cols = [...Object.keys(set).map((c) => `${c} = ?`), 'enrolment_revision = ?'];
  return stmt(db(), `UPDATE wallet_provider_accounts SET ${cols.join(', ')} WHERE id = ?`, [
    ...Object.values(set),
    revision,
    a.id,
  ]);
};

/** The account update of a step: `set` columns plus the next enrolment_revision (or the given one). */
export async function updateEnrolment(
  a: Acct,
  set: Record<string, SqlValue>,
  revision?: number,
): Promise<void> {
  await updateStmt(a, set, revision ?? (await enrolmentRevision(a)) + 1).run();
}

async function step(a: Acct, event: EnrolmentEvent, set: Record<string, SqlValue>): Promise<void> {
  const revision = (await enrolmentRevision(a)) + 1;
  await batch(db(), [enrolmentEventStmt(a, revision, event), updateStmt(a, set, revision)]);
}

/** Source event and update; the same UPDATE turns the enrolment Off. */
export const setSource = (a: Acct, c: Cred) =>
  step(
    a,
    { kind: 'source', credentialId: c.id },
    { credential_source_id: c.id, identity_hash: c.identity, enabled_at: null },
  );

export interface EnableOptions {
  checkId?: string | null;
  roundTrip?: EnrolmentEvent['roundTrip'];
  credentialId?: string;
}

/** Enable event with a fresh check (unless given); the enabled_at stamp is the event's. */
export async function enable(a: Acct, c: Cred, o: EnableOptions = {}): Promise<void> {
  const checkId =
    o.checkId === undefined
      ? await addCheck(c.id, (await currentVersion(c.id)) ?? c.versionId)
      : o.checkId;
  const at = Date.now();
  await step(
    a,
    {
      kind: 'enable',
      credentialId: o.credentialId ?? c.id,
      checkId,
      ...(o.roundTrip ? { roundTrip: o.roundTrip } : {}),
      createdAt: at,
    },
    { enabled_at: at },
  );
}

export const disable = (a: Acct) => step(a, { kind: 'disable' }, { enabled_at: null });

export function hold(a: Acct, reason = 'abuse'): Promise<void> {
  const at = Date.now();
  return step(
    a,
    { kind: 'hold', reason, createdAt: at },
    { enabled_at: null, platform_hold_at: at, platform_hold_reason: reason },
  );
}

export const release = (a: Acct) =>
  step(a, { kind: 'release' }, { platform_hold_at: null, platform_hold_reason: null });

/**
 * A callback receipt on a Test enrolment: a blocked instance on a Test pass carries it, with the 0043
 * insert guards dropped for the seed, since no live path writes a receipt without a real issuance.
 */
export function receiptSeeder(f: Awaited<ReturnType<typeof seedOrg>>['f'], orgId: string) {
  const instances = new Map<Provider, string>();
  async function instance(provider: Provider): Promise<string> {
    const known = instances.get(provider);
    if (known) return known;
    const pass = await makePass(f, { orgId, template: makeTemplate().resolved, mode: 'test' });
    const id = uid();
    await withoutTrigger(db(), 'wallet_provider_generation_insert_guard', () =>
      run(
        db(),
        `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at)
         VALUES (?, ?, ?, 'test', ?, 1, 'blocked', 0, 1, 1)`,
        [id, pass.id, orgId, provider],
      ),
    );
    instances.set(provider, id);
    return id;
  }
  return {
    async google(a: Acct, receivedAt: number, eventType: 'save' | 'del' = 'save'): Promise<string> {
      const instanceId = await instance('google');
      const id = uid();
      await withoutTrigger(db(), 'wallet_provider_generation_google_receipt', () =>
        run(
          db(),
          `INSERT INTO wallet_google_callback_receipts (id, instance_id, account_id, org_id, mode, event_type, nonce_hash, expires_at, received_at, kek_version, iv, wrapped_dek, ciphertext)
           VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            id,
            instanceId,
            a.id,
            orgId,
            eventType,
            ident(),
            receivedAt + 1000,
            receivedAt,
            bytes(12),
            bytes(60),
            bytes(40),
          ],
        ),
      );
      return id;
    },
    async samsung(
      a: Acct,
      receivedAt: number,
      event: 'ADDED' | 'DELETED' = 'ADDED',
    ): Promise<string> {
      const instanceId = await instance('samsung');
      const refId = uid();
      const id = uid();
      await withoutTrigger(db(), 'wallet_provider_generation_samsung_ref', () =>
        run(
          db(),
          `INSERT INTO wallet_samsung_fetch_refs (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at, retired_at, kek_version, iv, wrapped_dek, ciphertext)
           VALUES (?, ?, ?, 1, 1, 2, 1, 1, ?, ?, ?)`,
          [refId, ident(), instanceId, bytes(12), bytes(60), bytes(40)],
        ),
      );
      await withoutTrigger(db(), 'wallet_provider_generation_samsung_receipt', () =>
        run(
          db(),
          `INSERT INTO wallet_samsung_callback_receipts (id, ref_id, instance_id, account_id, org_id, mode, operation_version, kind, signed_at, received_at, kek_version, iv, wrapped_dek, ciphertext, event)
           VALUES (?, ?, ?, ?, ?, 'test', 1, 'state_callback', ?, ?, 1, ?, ?, ?, ?)`,
          [
            id,
            refId,
            instanceId,
            a.id,
            orgId,
            receivedAt,
            receivedAt,
            bytes(12),
            bytes(60),
            bytes(40),
            event,
          ],
        ),
      );
      return id;
    },
  };
}
