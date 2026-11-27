import { jobGrant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CREATE_CODES } from './create-grant.ts';
import { type Conflict, same } from './identity-move-carry.ts';
import { copyPersonalization, stageFiles, TABLES, writeRows } from './identity-move-state.ts';
import { publishPass } from './publish.ts';
import { type MoveRow, moveById, setCarriedState } from './repo-identity-move.ts';
import {
  checkInOf,
  copyCheckIn,
  dropCheckIn,
  dropSealed,
  readState,
  sealedOf,
} from './repo-identity-move-state.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';

/** One thing a pass holds, as a value that changes when the thing does, and when it was last written. */
export interface Item {
  v: string;
  at: number;
}
export type Fingerprint = Record<string, Item>;

/** The per-pass state a move carries (photo, assets, notes, check-in rules, personalization) as fingerprints. */
export async function fingerprintOf(db: D1Database, passId: string): Promise<Fingerprint> {
  const [state, rules, sealed] = await Promise.all([
    readState(db, passId),
    checkInOf(db, passId),
    sealedOf(db, passId),
  ]);
  const f: Fingerprint = {};
  const p = state.photo;
  if (p) f.photo = { v: `${p.sha1}:${p.version}:${p.include_in_pass}`, at: p.updated_at };
  for (const a of state.assets) f[`asset:${a.name}`] = { v: a.sha1, at: a.created_at };
  for (const n of state.notes)
    f[`note:${n.idempotency_key}`] = {
      v: `${await sha256Hex(n.body)}:${n.edited_at ?? ''}`,
      at: n.edited_at ?? n.created_at,
    };
  if (rules) f.checkin = { v: await sha256Hex(rules.rules), at: rules.updated_at };
  if (sealed) f.personalization = { v: sealed.token_sha256, at: sealed.created_at };
  return f;
}

/**
 * The three-way merge of the state carry, per item. An item the old pass changed since the copy (`base`) is
 * taken, unless the replacement changed it too: then the newer write wins and the item is reported. Items the
 * old pass did not change, and changes made on the replacement, stay.
 */
export function stateThreeWay(v: {
  base: Fingerprint;
  madeBase: Fingerprint;
  old: Fingerprint;
  made: Fingerprint;
}): { take: string[]; conflicts: Conflict[] } {
  const take: string[] = [];
  const conflicts: Conflict[] = [];
  for (const key of new Set([...Object.keys(v.old), ...Object.keys(v.base)])) {
    if (same(v.old[key]?.v, v.base[key]?.v)) continue;
    const madeChanged = !same(v.made[key]?.v, v.madeBase[key]?.v);
    if (madeChanged && same(v.made[key]?.v, v.old[key]?.v)) continue;
    if (madeChanged) {
      const oldNewer = (v.old[key]?.at ?? 0) > (v.made[key]?.at ?? 0);
      conflicts.push({ field: key, winner: oldNewer ? 'old' : 'replacement' });
      if (!oldNewer) continue;
    }
    take.push(key);
  }
  return { take, conflicts };
}

/** Clears what the replacement holds of the taken items, so the old pass's version is written in its place. */
async function dropTaken(ctx: ServiceContext, made: Pass, take: string[]): Promise<void> {
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.pass.identity_move_carry',
    job: 'identity-move',
    orgId: made.orgId,
    mode: made.mode,
    target: made.id,
    checks: [rowIs('passes', made.id, { deleted_at: null }, 'lineage')],
    codes: CREATE_CODES,
    tables: TABLES,
  });
  for (const key of take) {
    if (key === 'photo') g.delete('member_photos', { where: { pass_id: made.id } });
    else if (key.startsWith('asset:'))
      g.joined('pass_assets', {
        via: 'pass_id',
        where: { pass_id: made.id, name: key.slice(6) },
        delete: true,
      });
    else if (key.startsWith('note:'))
      g.delete('pass_notes', { where: { pass_id: made.id, idempotency_key: key.slice(5) } });
  }
  await g.commit();
}

/** Writes the taken items of the old pass onto the replacement. True when it wrote or removed anything. */
async function applyTaken(
  ctx: ServiceContext,
  old: Pass,
  made: Pass,
  take: string[],
): Promise<boolean> {
  const db = ctx.env.DB;
  const state = await readState(db, old.id);
  const files = await stageFiles(ctx, old, made.id, state);
  // An image object that is gone cannot be carried: the replacement keeps what it has, and the move goes on.
  const withFiles = files !== null;
  if (!withFiles)
    ctx.log.warn('identity_move.recarry_files_missing', {
      code: 'IDENTITY_MOVE_FILES',
      passId: old.id,
    });
  const rows = take.filter((k) => withFiles || !(k === 'photo' || k.startsWith('asset:')));
  if (rows.some((k) => k === 'photo' || k.startsWith('asset:') || k.startsWith('note:')))
    await dropTaken(ctx, made, rows);
  const has = (k: string) => rows.includes(k);
  await writeRows(
    ctx,
    made,
    {
      assets: (files?.assets ?? []).filter((a) => has(`asset:${a.name}`)),
      photo: has('photo') ? (files?.photo ?? null) : null,
    },
    state.notes.filter((n) => has(`note:${n.idempotency_key}`)),
  );
  if (has('checkin')) {
    await dropCheckIn(db, made.id);
    await copyCheckIn(db, old, made.id, ctx.clock.now());
  }
  if (has('personalization')) {
    await dropSealed(db, made.id);
    await copyPersonalization(ctx, old, made);
  }
  return rows.length > 0;
}

/**
 * At the void, whatever the old pass took on since the copy (a late "Do not admit" note, a changed photo,
 * check-in rules, personalization) goes to the replacement as a three-way diff (`stateThreeWay`), so the void
 * loses nothing and edits made on the replacement survive. The result becomes the next base.
 */
export async function recarryState(ctx: ServiceContext, row: MoveRow, old: Pass): Promise<void> {
  const db = ctx.env.DB;
  const fresh = await moveById(db, row.id);
  const made = await getPass(db, row.new_pass_id, row.org_id);
  if (!fresh?.copied_state || !fresh.made_state || !made) return;
  const oldNow = await fingerprintOf(db, old.id);
  const merged = stateThreeWay({
    base: JSON.parse(fresh.copied_state) as Fingerprint,
    madeBase: JSON.parse(fresh.made_state) as Fingerprint,
    old: oldNow,
    made: await fingerprintOf(db, made.id),
  });
  if (merged.take.length === 0 && merged.conflicts.length === 0) return;
  if (await applyTaken(ctx, old, made, merged.take))
    await publishPass(ctx, {
      passId: made.id,
      orgScope: row.org_id,
      cause: 'admin',
      source: 'move',
      sourceRef: `carry:${row.id}`,
      actor: { type: 'system', id: null },
      force: true,
      notify: false,
      mutate: () => ({}),
    });
  const seen = [...(JSON.parse(fresh.conflicts ?? '[]') as Conflict[]), ...merged.conflicts];
  await setCarriedState(
    db,
    row.id,
    {
      copied: JSON.stringify(oldNow),
      made: JSON.stringify(await fingerprintOf(db, made.id)),
      conflicts: seen.length > 0 ? JSON.stringify(seen) : null,
    },
    ctx.clock.now(),
  );
}
