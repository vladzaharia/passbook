// Raw-SQL seeds for the 0112 schema tests, credential side. A step (rotate, verify, revoke) is its rows and
// its update in one D1 batch, as a writer commits it: a refusal rolls the whole step back, so a case can try
// again. Single statements (insertVersion, insertCredentialEvent) leave out a part.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';

export type Mode = 'live' | 'test';
export type Provider = 'google' | 'samsung';

export const db = () => env.DB;
export const uid = () => crypto.randomUUID();
/** Storage lasts for the whole test file and these rows are never deleted, so identities are unique unless a case names one. */
export const ident = () => `${uid()}${uid()}`.replaceAll('-', '').slice(0, 64);
export const bytes = (n: number) => new Uint8Array(n).fill(7);

/** The promise rejects with a message that matches. */
export const refused = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

export async function seedOrg() {
  const f = fixtures(await makeEnv());
  return { f, org: await makeOrg(f) };
}

export interface Cred {
  id: string;
  versionId: string;
  identity: string;
}

interface CredentialInput {
  scope?: 'platform' | 'org';
  orgId?: string | null;
  mode?: Mode;
  provider?: Provider;
  identity?: string;
  hint?: string;
}

const INSERT_VERSION = `INSERT INTO wallet_credential_versions (id, credential_id, identity_hash, card_map, kek_version, iv, wrapped_dek, ciphertext, created_at)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`;
const INSERT_CREDENTIAL_EVENT = `INSERT INTO wallet_credential_events (id, credential_id, revision, kind, version_id, actor_type, actor_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export async function insertCredential(
  o: CredentialInput = {},
): Promise<{ id: string; identity: string }> {
  const scope = o.scope ?? 'org';
  const id = uid();
  const identity = o.identity ?? ident();
  await run(
    db(),
    `INSERT INTO wallet_credentials (id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    [
      id,
      scope,
      scope === 'platform' ? null : (o.orgId ?? null),
      o.mode ?? 'live',
      o.provider ?? 'google',
      identity,
      o.hint ?? 'abcd',
    ],
  );
  return { id, identity };
}

export async function insertVersion(
  credentialId: string,
  identity: string,
  cardMap = '{}',
): Promise<string> {
  const id = uid();
  await run(db(), INSERT_VERSION, [
    id,
    credentialId,
    identity,
    cardMap,
    bytes(12),
    bytes(60),
    bytes(40),
  ]);
  return id;
}

export interface CredentialEvent {
  credentialId: string;
  revision: number;
  kind: 'create' | 'rotate' | 'revoke' | 'verify';
  versionId?: string | null;
  actorType?: 'user' | 'platform' | 'system';
  createdAt?: number;
}

const credentialEventStmt = (e: CredentialEvent) => {
  const actor = e.actorType ?? 'system';
  return stmt(db(), INSERT_CREDENTIAL_EVENT, [
    uid(),
    e.credentialId,
    e.revision,
    e.kind,
    e.versionId ?? null,
    actor,
    actor === 'system' ? null : 'u1',
    e.createdAt ?? Date.now(),
  ]);
};

export const insertCredentialEvent = (e: CredentialEvent) => credentialEventStmt(e).run();

export const credentialRevision = async (id: string) =>
  (
    await first<{ r: number }>(db(), 'SELECT revision AS r FROM wallet_credentials WHERE id = ?', [
      id,
    ])
  )?.r ?? 0;

export const currentVersion = async (id: string) =>
  (
    await first<{ v: string | null }>(
      db(),
      'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
      [id],
    )
  )?.v;

const pointer = (id: string, revision: number, versionId: string) =>
  stmt(db(), 'UPDATE wallet_credentials SET revision = ?, current_version_id = ? WHERE id = ?', [
    revision,
    versionId,
    id,
  ]);

/** A revoked credential frees its platform slot. Only a credential with a version can be revoked. */
export async function revokeCredential(
  id: string,
  actorType: 'user' | 'platform' = 'user',
): Promise<void> {
  const revision = (await credentialRevision(id)) + 1;
  await batch(db(), [
    credentialEventStmt({ credentialId: id, revision, kind: 'revoke', actorType }),
    stmt(db(), 'UPDATE wallet_credentials SET revision = ?, revoked_at = ? WHERE id = ?', [
      revision,
      Date.now(),
      id,
    ]),
  ]);
}

/** The platform slot of a mode and provider holds one active credential: frees it for the next case. */
async function clearPlatform(mode: Mode, provider: Provider): Promise<void> {
  const active = await first<{ id: string }>(
    db(),
    "SELECT id FROM wallet_credentials WHERE scope = 'platform' AND mode = ? AND provider = ? AND revoked_at IS NULL",
    [mode, provider],
  );
  if (active) await revokeCredential(active.id, 'platform');
}

/** A credential at revision 1: row, first version, create event, then the pointer. A platform one replaces the last. */
export async function credential(o: CredentialInput & { cardMap?: string } = {}): Promise<Cred> {
  if (o.scope === 'platform') await clearPlatform(o.mode ?? 'live', o.provider ?? 'google');
  const { id, identity } = await insertCredential(o);
  const versionId = uid();
  await batch(db(), [
    stmt(db(), INSERT_VERSION, [
      versionId,
      id,
      identity,
      o.cardMap ?? '{}',
      bytes(12),
      bytes(60),
      bytes(40),
    ]),
    credentialEventStmt({ credentialId: id, revision: 1, kind: 'create', versionId }),
    pointer(id, 1, versionId),
  ]);
  return { id, versionId, identity };
}

/** Appends a version with a rotate event and moves the pointer; the `c.versionId` of a case stays its first. */
export async function rotate(c: Cred, cardMap = '{}'): Promise<string> {
  const revision = (await credentialRevision(c.id)) + 1;
  const versionId = uid();
  await batch(db(), [
    stmt(db(), INSERT_VERSION, [
      versionId,
      c.id,
      c.identity,
      cardMap,
      bytes(12),
      bytes(60),
      bytes(40),
    ]),
    credentialEventStmt({ credentialId: c.id, revision, kind: 'rotate', versionId }),
    pointer(c.id, revision, versionId),
  ]);
  return versionId;
}

export async function addCheck(
  credentialId: string,
  versionId: string,
  ok = 1,
  checkedAt?: number,
): Promise<string> {
  const id = uid();
  if (checkedAt === undefined)
    await run(
      db(),
      'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok) VALUES (?, ?, ?, ?)',
      [id, credentialId, versionId, ok],
    );
  else
    await run(
      db(),
      'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok, checked_at) VALUES (?, ?, ?, ?, ?)',
      [id, credentialId, versionId, ok, checkedAt],
    );
  return id;
}

/** A verify event and the verified_at stamp, after the successful check of the current version a writer needs. */
export async function verify(c: Cred, checked = true): Promise<void> {
  if (checked) await addCheck(c.id, (await currentVersion(c.id)) ?? c.versionId);
  const revision = (await credentialRevision(c.id)) + 1;
  const at = Date.now();
  await batch(db(), [
    credentialEventStmt({ credentialId: c.id, revision, kind: 'verify', createdAt: at }),
    stmt(db(), 'UPDATE wallet_credentials SET revision = ?, verified_at = ? WHERE id = ?', [
      revision,
      at,
      c.id,
    ]),
  ]);
}
