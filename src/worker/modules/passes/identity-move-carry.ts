import type { Personalization } from '../../../passkit/types.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import { stableStringify } from './create.ts';
import { gone } from './identity-move-revoke.ts';
import { publishPass } from './publish.ts';
import { lastEditAt, type MoveRow, setCarried } from './repo-identity-move.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';
import { stampMovePlan } from './stamps-keep.ts';

/** The key of the template's message field: the move's own tell lives there, so edits are compared without it. */
export async function messageKey(ctx: ServiceContext, pass: Pass): Promise<string | null> {
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  return template.manifest.messaging?.input ?? null;
}

export function without(p: Personalization, key: string | null): Personalization {
  if (key === null) return p;
  const { [key]: _tell, ...rest } = p;
  return rest;
}

export const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export interface Conflict {
  field: string;
  winner: 'old' | 'replacement';
}

/**
 * The three-way merge of an edit carry. `base` is the old pass as copied; `madeBase` the replacement as it was
 * made from it. A field the old pass changed since the copy goes to the replacement, unless the replacement
 * changed it too: then the newer write wins (`oldNewer`) and the field is reported. Fields the old pass did not
 * change, and edits made on the replacement, stay as they are. `oldMapped` is the old input run through the
 * stamp plan, the form the replacement's version holds.
 */
export function threeWay(v: {
  base: Personalization;
  madeBase: Personalization;
  old: Personalization;
  oldMapped: Personalization;
  made: Personalization;
  oldNewer: boolean;
}): { next: Personalization; conflicts: Conflict[] } {
  const next: Personalization = { ...v.made };
  const conflicts: Conflict[] = [];
  for (const field of new Set([...Object.keys(v.old), ...Object.keys(v.base)])) {
    if (same(v.old[field], v.base[field])) continue;
    const take = v.oldMapped[field];
    const madeChanged = !same(v.made[field], v.madeBase[field]);
    if (madeChanged && same(v.made[field], take)) continue;
    if (madeChanged) {
      conflicts.push({ field, winner: v.oldNewer ? 'old' : 'replacement' });
      if (!v.oldNewer) continue;
    }
    if (take === undefined) delete next[field];
    else next[field] = take;
  }
  return { next, conflicts };
}

/**
 * Before the old pass voids, the edits made to it since the copy go to the replacement as a three-way diff
 * (see `threeWay`), so the void loses nothing and the replacement's own edits survive. The result becomes the
 * next base, and the fields both passes edited are recorded on the row.
 */
export async function carryEdits(ctx: ServiceContext, row: MoveRow, old: Pass): Promise<void> {
  const db = ctx.env.DB;
  const key = await messageKey(ctx, old);
  const oldInput = without(old.personalization, key);
  const input = stableStringify(oldInput);
  const hash = await sha256Hex(input);
  if (hash === row.copied_hash) return;
  const target = await getPass(db, row.new_pass_id, row.org_id);
  if (!target || gone(target))
    throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement is gone.');
  const plan = await stampMovePlan(
    ctx,
    { orgId: target.orgId, templateId: target.templateId, version: target.templateVersion },
    [old.templateVersion],
  );
  const oldMapped =
    plan({
      templateVersion: old.templateVersion,
      personalization: oldInput,
      fieldSources: old.fieldSources,
    }).personalization ?? oldInput;
  const oldNewer = (await lastEditAt(db, old.id)) > (await lastEditAt(db, target.id));
  const base = JSON.parse(row.copied_input ?? '{}') as Personalization;
  const madeBase = JSON.parse(row.made_input ?? '{}') as Personalization;
  let conflicts: Conflict[] = [];
  await publishPass(ctx, {
    passId: row.new_pass_id,
    orgScope: row.org_id,
    cause: 'admin',
    source: 'move',
    sourceRef: `carry:${row.id}`,
    actor: { type: 'system', id: null },
    notify: false,
    mutate: (made) => {
      if (gone(made)) throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement is gone.');
      // The plan was built for this version: a version change in between retries on the next sweep.
      if (made.templateVersion !== target.templateVersion)
        throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement changed version.');
      const merged = threeWay({
        base,
        madeBase,
        old: oldInput,
        oldMapped,
        made: made.personalization,
        oldNewer,
      });
      conflicts = merged.conflicts;
      return { personalization: merged.next };
    },
  });
  await setCarried(
    db,
    row.id,
    {
      hash,
      input,
      conflicts: conflicts.length > 0 ? JSON.stringify(conflicts) : null,
    },
    ctx.clock.now(),
  );
}
