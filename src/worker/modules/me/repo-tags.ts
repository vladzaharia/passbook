import type { Mode } from '../../../shared/contracts/common.ts';
import type { MyTag } from '../../../shared/contracts/me.ts';
import { all } from '../../platform/db.ts';

type Db = D1Database;

/** A lost tag stays on the holder's passes this long. */
export const LOST_LISTED_MS = 30 * 24 * 60 * 60 * 1000;

interface TagRaw {
  id: string;
  label: string | null;
  hint: string;
  org_id: string;
  mode: Mode;
  scope: 'pass' | 'user';
  pass_id: string;
  bound_at: number;
  lost_at: number | null;
}

const COLUMNS = `t.id, t.label, t.hint, t.org_id, t.mode, b.scope, b.pass_id, b.bound_at, t.lost_at`;

/**
 * The tags on these passes, which the caller owns: what opens each one and the holder's own tags that
 * were reported lost. Only the holder's own bindings are read; a tag of another holder never matches.
 */
export async function tagsByPass(
  db: Db,
  userId: string,
  passes: readonly { id: string; org_id: string; mode: Mode }[],
  now: number,
): Promise<Map<string, MyTag[]>> {
  const byPass = new Map<string, MyTag[]>();
  if (passes.length === 0) return byPass;
  const ids = JSON.stringify(passes.map((p) => p.id));
  const [active, lost] = await Promise.all([
    all<TagRaw>(
      db,
      `SELECT ${COLUMNS} FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
       LEFT JOIN passes p ON p.id = b.pass_id
       WHERE b.ended_at IS NULL AND t.status = 'active' AND t.lost_at IS NULL
         AND ((b.scope = 'pass' AND p.owner_user_id = ? AND b.pass_id IN (SELECT value FROM json_each(?)))
           OR (b.scope = 'user' AND b.user_id = ?))
       ORDER BY b.bound_at DESC, t.id DESC`,
      [userId, ids, userId],
    ),
    all<TagRaw>(
      db,
      `SELECT ${COLUMNS} FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
       LEFT JOIN passes p ON p.id = b.pass_id
       WHERE t.status = 'active' AND t.lost_at IS NOT NULL AND t.lost_at > ?
         AND b.end_cause = 'lost'
         AND b.rowid = (SELECT max(l.rowid) FROM tag_bindings l WHERE l.tag_id = t.id AND l.end_cause = 'lost')
         AND ((b.scope = 'pass' AND b.holder_owner = ? AND p.owner_user_id = ?
               AND p.credential_generation = b.holder_generation
               AND b.pass_id IN (SELECT value FROM json_each(?)))
           OR (b.scope = 'user' AND b.user_id = ?))
       ORDER BY t.lost_at DESC, t.id DESC`,
      [now - LOST_LISTED_MS, userId, userId, ids, userId],
    ),
  ]);
  for (const row of [...active, ...lost]) {
    const tag: MyTag = {
      id: row.id,
      label: row.label,
      hint: row.hint,
      scope: row.scope,
      boundAt: row.bound_at,
      lostAt: row.lost_at,
    };
    for (const pass of passes) {
      const here =
        row.scope === 'pass'
          ? pass.id === row.pass_id
          : pass.org_id === row.org_id && pass.mode === row.mode;
      if (here) byPass.set(pass.id, [...(byPass.get(pass.id) ?? []), tag]);
    }
  }
  return byPass;
}
