import { makeUser } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import type { Pass } from '../passes/repo-map.ts';
import { act, kit, out } from './act-test-fixtures.ts';
import { key, setPass } from './test-kit.ts';

let seq = 0;
/** A fresh 7-byte UID. */
export const nextUid = () => `04a1${(++seq).toString(16).padStart(10, '0')}`;

export const tagInput = (uid: string, extra: Record<string, unknown> = {}) => ({
  tag: { uid, tech: 'a', source: 'native' },
  method: 'nfc',
  ...extra,
});

export async function tagsOn(orgId: string = kit.org.id, enabled = true) {
  await run(
    kit.env.DB,
    `INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', ?, 1)
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    [`org:${orgId}`, JSON.stringify({ enabled })],
  );
}

/** A tag bound to a pass, or to the user who owns it. */
export async function bindTag(
  uid: string,
  pass: Pass,
  options: { userId?: string; mode?: Mode } = {},
): Promise<{ tagId: string; bindingId: string }> {
  const mode = options.mode ?? pass.mode;
  const { ref, hint } = await tagRef(kit.env, pass.orgId, mode, uid);
  const now = kit.clock.now();
  let tag = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM nfc_tags WHERE org_id = ? AND mode = ? AND tag_ref = ?',
    [pass.orgId, mode, ref],
  );
  if (!tag) {
    tag = { id: kit.fx.ids.id() };
    await run(
      kit.env.DB,
      `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES (?, ?, ?, ?, 'uid', ?, ?)`,
      [tag.id, pass.orgId, mode, ref, hint, now],
    );
  }
  const bindingId = kit.fx.ids.id();
  const owner = await first<{ owner_user_id: string | null; credential_generation: number }>(
    kit.env.DB,
    'SELECT owner_user_id, credential_generation FROM passes WHERE id = ?',
    [pass.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, user_id, source, bound_at, bound_by_type, bound_by,
       holder_generation, holder_owner) VALUES (?, ?, ?, ?, ?, 'admin', ?, 'user', 'admin-1', ?, ?)`,
    [
      bindingId,
      tag.id,
      options.userId ? 'user' : 'pass',
      pass.id,
      options.userId ?? null,
      now,
      owner?.credential_generation ?? 1,
      owner?.owner_user_id ?? null,
    ],
  );
  return { tagId: tag.id, bindingId };
}

/** A pass owned by a user account (attached), in the kit's org unless told otherwise. */
export async function ownedPass(
  templateId: string,
  userId: string,
  input: Record<string, unknown> = {},
  options: { mode?: Mode; orgId?: string } = {},
): Promise<Pass> {
  const email = `${userId}@example.com`;
  const pass = await kit.scanPass(templateId, input, { ...options, holderEmail: email });
  await setPass(kit, pass.id, 'owner_user_id = ?', [userId]);
  return { ...pass, ownerUserId: userId };
}

export const holder = async () => (await makeUser(kit.fx)).id;

export const resolveTag = async (headers: Record<string, string>, uid: string) =>
  out(
    await kit.post(headers, '/resolve', {
      idempotencyKey: key(),
      input: tagInput(uid),
      clientTs: kit.clock.now(),
    }),
  );

export const actTag = async (
  headers: Record<string, string>,
  uid: string,
  over: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Promise<ScanOutcome> => out(await act(headers, tagInput(uid, extra), over));
