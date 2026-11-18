import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

type Db = D1Database;

export interface BindingRow {
  id: string;
  tagId: string;
  scope: 'pass' | 'user';
  passId: string;
  userId: string | null;
  /** The pass's owner now, for telling the same holder from another. */
  passOwnerId: string | null;
  endCause: string | null;
  holderGeneration: number;
  holderOwner: string | null;
}

export interface PassFacts {
  id: string;
  orgId: string;
  mode: Mode;
  ownerUserId: string | null;
  credentialGeneration: number;
  deletedAt: number | null;
}

interface BindingRaw {
  id: string;
  tag_id: string;
  scope: 'pass' | 'user';
  pass_id: string;
  user_id: string | null;
  owner_user_id: string | null;
  end_cause: string | null;
  holder_generation: number;
  holder_owner: string | null;
}

const toBinding = (r: BindingRaw): BindingRow => ({
  id: r.id,
  tagId: r.tag_id,
  scope: r.scope,
  passId: r.pass_id,
  userId: r.user_id,
  passOwnerId: r.owner_user_id,
  endCause: r.end_cause,
  holderGeneration: r.holder_generation,
  holderOwner: r.holder_owner,
});

const BINDING = `SELECT b.id, b.tag_id, b.scope, b.pass_id, b.user_id, p.owner_user_id, b.end_cause, b.holder_generation, b.holder_owner
  FROM tag_bindings b JOIN passes p ON p.id = b.pass_id`;

export async function activeBinding(db: Db, tagId: string): Promise<BindingRow | null> {
  const r = await first<BindingRaw>(db, `${BINDING} WHERE b.tag_id = ? AND b.ended_at IS NULL`, [
    tagId,
  ]);
  return r ? toBinding(r) : null;
}

/** The binding that was ended by the lost report: where a restore puts the tag back. */
export async function lostBinding(db: Db, tagId: string): Promise<BindingRow | null> {
  const r = await first<BindingRaw>(
    db,
    `${BINDING} WHERE b.tag_id = ? AND b.end_cause = 'lost' ORDER BY b.rowid DESC LIMIT 1`,
    [tagId],
  );
  return r ? toBinding(r) : null;
}

/** A binding by id, with its tag's tenant, before any authority exists for it. */
export async function bindingTarget(
  db: Db,
  id: string,
): Promise<(BindingRow & { orgId: string; mode: Mode; ended: boolean }) | null> {
  const r = await first<BindingRaw & { org_id: string; mode: Mode; ended_at: number | null }>(
    db,
    `SELECT b.id, b.tag_id, b.scope, b.pass_id, b.user_id, p.owner_user_id, b.end_cause, b.holder_generation, b.holder_owner, t.org_id, t.mode, b.ended_at
     FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id JOIN passes p ON p.id = b.pass_id WHERE b.id = ?`,
    [id],
  );
  return r ? { ...toBinding(r), orgId: r.org_id, mode: r.mode, ended: r.ended_at !== null } : null;
}

export async function passFacts(db: Db, passId: string): Promise<PassFacts | null> {
  const r = await first<{
    id: string;
    org_id: string;
    mode: Mode;
    owner_user_id: string | null;
    credential_generation: number;
    deleted_at: number | null;
  }>(
    db,
    'SELECT id, org_id, mode, owner_user_id, credential_generation, deleted_at FROM passes WHERE id = ?',
    [passId],
  );
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        mode: r.mode,
        ownerUserId: r.owner_user_id,
        credentialGeneration: r.credential_generation,
        deletedAt: r.deleted_at,
      }
    : null;
}
