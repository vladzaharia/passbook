import type { Json } from '../../../passkit/types.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { passRow } from '../../platform/authority-checks.ts';
import { AppError } from '../../platform/errors.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { type PublishCommit, publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { schemaOf } from './effects-value.ts';
import { addUndoWrites, openUndoGrant, UNDO_CODES, type UndoCommit } from './repo-undo.ts';
import { readScanValue } from './repo-undo-value.ts';
import { superseded } from './undo-authority.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Undo an add, take, set or use up: the pass is published back and the undo's rows (gate, target,
 * scan, event, audit) commit in the same batch. An add and a take reverse what they actually
 * changed (a capped add gives back less); a set only if the value is still the one it wrote.
 */
export async function commitValueUndo(c: UndoCommit): Promise<void> {
  const { ctx, actor, target } = c;
  const db = ctx.env.DB;
  const [value, pass] = await Promise.all([
    readScanValue(db, actor.orgId, target.id),
    getPass(db, target.passId, actor.orgId),
  ]);
  if (!value || !pass) throw superseded();
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const action = scanOf(template.manifest).actions.find((a) => a.id === target.actionId);
  const input = action?.input ?? '';
  if (!action || (target.actionKind !== 'use_up' && !input)) throw superseded();
  const minimum = schemaOf(template.manifest, input)?.minimum;
  let committed = false;
  const commit: PublishCommit = {
    open: (checks) =>
      openUndoGrant(c, { checks, codes: { ...UNDO_CODES, stale: 'PASS_CONFLICT' } }),
    when: [],
    async add(g) {
      addUndoWrites(g, c);
      return {
        settle() {
          committed = true;
        },
      };
    },
  };
  const published = await publishPass(ctx, {
    passId: pass.id,
    orgScope: actor.orgId,
    cause: actor.actor.type === 'user' ? 'admin' : 'api',
    source: 'scan',
    actor: actor.actor,
    notify: false,
    commit,
    mutate(current) {
      if (current.templateVersion !== pass.templateVersion) throw superseded();
      const kind = target.actionKind;
      if (kind === 'use_up') {
        if (current.status !== 'voided' || current.removedAt !== null) throw superseded();
        return { status: 'active' };
      }
      const now = current.personalization[input] as Json | undefined;
      let next: Json;
      if (kind === 'set') {
        if (JSON.stringify(now) !== JSON.stringify(value.after)) throw superseded();
        next = value.before as Json;
      } else {
        const delta = num(value.after) - num(value.before);
        const back = num(now) - delta;
        next = typeof minimum === 'number' ? Math.max(minimum, back) : back;
      }
      return { personalization: { ...current.personalization, [input]: next } };
    },
  });
  if (committed) return;
  // Nothing about the pass changes (a floor was already reached): the undo's rows commit alone.
  if (published.changed)
    throw new AppError('UNDO_UNCONFIRMED', 500, 'The undo could not be confirmed.');
  const g = addUndoWrites(
    openUndoGrant(c, { checks: passRow(published.pass.id, published.pass.rowVersion) }),
    c,
  );
  await g.commit();
}
