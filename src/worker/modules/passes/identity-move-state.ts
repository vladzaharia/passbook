import { jobGrant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { credentialAad, decryptSecret, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CREATE_CODES } from './create-grant.ts';
import {
  type AssetRow,
  carriedCount,
  copyCheckIn,
  insertSealed,
  type NoteRow,
  type PassState,
  type PhotoRow,
  sealedOf,
} from './repo-identity-move-state.ts';
import type { Pass } from './repo-map.ts';

/** The tables the carry writes through its grant; the rest are plain rows of this module's own. */
const TABLES = ['pass_assets', 'member_photos', 'pass_notes'] as const;

/** The key of a copied object: the same name under the replacement's id, so a rerun writes the same object. */
const rekey = (key: string, from: string, to: string): string =>
  key.includes(from) ? key.split(from).join(to) : `moved/${to}/${key}`;

/** Copies one stored image object under the replacement's key. False when the object is gone. */
async function copyObject(ctx: ServiceContext, from: string, to: string): Promise<boolean> {
  const object = await ctx.env.BUCKET.get(from);
  if (!object) return false;
  await ctx.env.BUCKET.put(to, await object.arrayBuffer(), {
    ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
  });
  return true;
}

/**
 * Copies the old pass's image objects to keys under the replacement, before the replacement exists: an object
 * that is gone leaves the pass where it is. The keys are the replacement's own, so removing either pass later
 * never deletes the other's image.
 */
export async function stageFiles(
  ctx: ServiceContext,
  old: Pass,
  newPassId: string,
  state: PassState,
): Promise<{ assets: AssetRow[]; photo: PhotoRow | null } | null> {
  const assets: AssetRow[] = [];
  for (const a of state.assets) {
    const key = rekey(a.r2_key, old.id, newPassId);
    if (!(await copyObject(ctx, a.r2_key, key))) return null;
    assets.push({ ...a, r2_key: key });
  }
  let photo: PhotoRow | null = null;
  if (state.photo) {
    const key = rekey(state.photo.r2_key, old.id, newPassId);
    if (!(await copyObject(ctx, state.photo.r2_key, key))) return null;
    photo = { ...state.photo, r2_key: key };
  }
  return { assets, photo };
}

/** Writes the copied rows for the replacement; every row is skipped when it already exists, so a rerun adds nothing. */
async function writeRows(
  ctx: ServiceContext,
  made: Pass,
  files: { assets: AssetRow[]; photo: PhotoRow | null },
  notes: NoteRow[],
): Promise<void> {
  if (files.assets.length === 0 && !files.photo && notes.length === 0) return;
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
  for (const a of files.assets)
    g.insertJoined('pass_assets', {
      parents: { pass_id: made.id },
      columns: ['name', 'r2_key', 'sha1', 'size', 'width', 'height', 'crc32', 'created_at'],
      values: [a.name, a.r2_key, a.sha1, a.size, a.width, a.height, a.crc32, a.created_at],
      when: [notExists('pass_assets', { pass_id: made.id, name: a.name })],
    });
  const p = files.photo;
  if (p)
    g.insertSelect(
      'member_photos',
      ['r2_key', 'sha1', 'size', 'crc32', 'include_in_pass', 'version', 'updated_at'],
      [p.r2_key, p.sha1, p.size, p.crc32, p.include_in_pass, p.version, p.updated_at],
      {
        from: { table: 'passes', where: { id: made.id }, copy: { pass_id: 'id' } },
        when: [notExists('member_photos', { pass_id: made.id })],
      },
    );
  for (const n of notes)
    g.insertSelect(
      'pass_notes',
      [
        'id',
        'credential_generation',
        'body',
        'author_name',
        'author_staff_id',
        'scanner_id',
        'idempotency_key',
        'created_at',
        'edited_at',
      ],
      [
        ctx.ids.id(),
        made.credentialGeneration,
        n.body,
        n.author_name,
        n.author_staff_id,
        n.scanner_id,
        n.idempotency_key,
        n.created_at,
        n.edited_at,
      ],
      {
        from: { table: 'passes', where: { id: made.id }, copy: { pass_id: 'id' } },
        when: [notExists('pass_notes', { pass_id: made.id, idempotency_key: n.idempotency_key })],
      },
    );
  await g.commit();
}

/**
 * Apple personalization is sealed under the pass id, so it is opened with the old id and sealed again under the
 * replacement's: the holder is not asked for it a second time.
 */
async function copyPersonalization(ctx: ServiceContext, old: Pass, made: Pass): Promise<void> {
  const row = await sealedOf(ctx.env.DB, old.id);
  if (!row) return;
  const ring = await loadKekRing(ctx.env);
  const plain = await decryptSecret(
    ring,
    {
      kekVersion: row.kek_version,
      iv: new Uint8Array(row.iv),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      ciphertext: new Uint8Array(row.ciphertext),
    },
    credentialAad(old.id, old.orgId, 'personalization'),
  );
  const sealed = await encryptSecret(
    ring,
    plain,
    credentialAad(made.id, made.orgId, 'personalization'),
  );
  await insertSealed(ctx.env.DB, made.id, row, sealed);
}

/**
 * Carries the rest of the old pass's state to the replacement: image rows, staff notes, check-in rules and
 * Apple personalization. True when anything was added, so the caller signs the replacement again with it.
 */
export async function carryState(
  ctx: ServiceContext,
  old: Pass,
  made: Pass,
  state: PassState,
  files: { assets: AssetRow[]; photo: PhotoRow | null },
): Promise<boolean> {
  const db = ctx.env.DB;
  const before = await carriedCount(db, made.id);
  await writeRows(ctx, made, files, state.notes);
  await copyCheckIn(db, old, made.id, ctx.clock.now());
  await copyPersonalization(ctx, old, made);
  return (await carriedCount(db, made.id)) > before;
}
