import type { PatchOp } from '../../../shared/contracts/broadcasts-change.ts';
import { changeOpsOf } from '../../../shared/contracts/broadcasts-change.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { formatValue } from '../../../shared/issuing/diff.ts';
import { type InputField, inputFields } from '../../../shared/issuing/fields.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo.ts';
import { budgetOutcomes, providerBudgets } from '../wallet-providers/notify-budget.ts';
import { actorOf } from './actor.ts';
import { fillTokens, resolveOps } from './change-ops.ts';
import type { BroadcastRow, ItemRow } from './repo.ts';
import { creatorLive } from './repo-creator.ts';
import { hasVersionFrom } from './repo-items.ts';
import { StoredBroadcastTargetSchema } from './stored-target.ts';

/** A change run read once per chunk: the ops, and the text with its tokens. */
export interface ChangePlan {
  ops: Record<string, PatchOp>;
  text: string | undefined;
  notify: boolean;
}

export const planOf = (row: BroadcastRow): ChangePlan =>
  row.kind === 'change'
    ? {
        ops: changeOpsOf(JSON.parse(row.patch) as Record<string, Json>).ops,
        text:
          row.notify === 1
            ? StoredBroadcastTargetSchema.parse(JSON.parse(row.target)).message
            : undefined,
        notify: row.notify === 1,
      }
    : { ops: {}, text: undefined, notify: false };

interface TemplateFields {
  fields: InputField[];
  schema: unknown;
}
/** The fields of each template version a chunk meets. */
export type FieldCache = Map<string, TemplateFields>;

async function fieldsOf(
  ctx: ServiceContext,
  cache: FieldCache,
  pass: Pass,
): Promise<TemplateFields> {
  const key = `${pass.templateId}@${pass.templateVersion}`;
  let hit = cache.get(key);
  if (!hit) {
    const { manifest } = await resolveTemplate(
      ctx,
      pass.orgId,
      pass.templateId,
      pass.templateVersion,
    );
    hit = { fields: inputFields(manifest.inputs), schema: manifest.inputs };
    cache.set(key, hit);
  }
  return hit;
}

const refused = (code: string) =>
  new ValidationError('This pass cannot take the change.', [], `CHANGE_${code}`);

/** The lock-screen text for one pass: each `{Label}` reads that field's new value as the form shows it. */
function textFor(
  plan: ChangePlan,
  t: TemplateFields,
  next: Record<string, Json>,
): string | undefined {
  if (!plan.text) return undefined;
  return fillTokens(plan.text, (label) => {
    const f = t.fields.find((x) => x.label.toLowerCase() === label.toLowerCase());
    return f ? formatValue(next[f.key], f) : null;
  });
}

/**
 * Applies a change run to one pass: the ops read the pass's own values (a shift or an add depends on
 * them), the touched inputs' values before and after are kept on the item for the undo, and every
 * write re-proves the run's creator. Never throws for a pass-level problem.
 */
export async function applyChange(
  ctx: ServiceContext,
  row: BroadcastRow,
  plan: ChangePlan,
  cache: FieldCache,
  pass: Pass,
): Promise<ItemRow> {
  const base = { passId: pass.id, silent: false };
  const template = await fieldsOf(ctx, cache, pass);
  const first = resolveOps(plan.ops, pass.personalization);
  if (!first.ok) {
    ctx.log.warn('broadcast.pass_failed', {
      broadcastId: row.id,
      passId: pass.id,
      code: first.code,
    });
    return { ...base, outcome: 'failed' };
  }
  if (JSON.stringify(first.from) === JSON.stringify(first.to))
    return { ...base, outcome: 'unchanged' };
  const seen: { values?: { from: Record<string, Json>; to: Record<string, Json> } } = {};
  try {
    const result = await publishPass(ctx, {
      passId: pass.id,
      orgScope: row.org_id,
      cause: row.created_by_type === 'api_key' ? 'api' : 'admin',
      source: 'schedule',
      actor: actorOf(row),
      dispatch: false,
      notify: plan.notify,
      ...(plan.text ? { changeText: textFor(plan, template, first.next) ?? plan.text } : {}),
      extraChecks: [creatorLive(row, ctx.clock.now())],
      mutate: (current) => {
        // The pass may have changed since selection; this reruns on each retry of the write.
        if (
          current.orgId !== row.org_id ||
          current.mode !== row.mode ||
          current.status !== 'active' ||
          current.removedAt !== null
        )
          throw refused('PASS_CHANGED');
        const again = resolveOps(plan.ops, current.personalization);
        if (!again.ok) throw refused(again.code);
        seen.values = { from: again.from, to: again.to };
        return { personalization: again.next };
      },
    });
    const moved =
      seen.values && JSON.stringify(seen.values.from) !== JSON.stringify(seen.values.to);
    if (!result.changed) {
      // An input no field renders is stored with no new version and no push: it reads unchanged, and
      // its earlier values are kept so the undo still restores it.
      if (moved)
        return {
          ...base,
          outcome: 'unchanged',
          before: JSON.stringify(seen.values),
          version: result.pass.version,
        };
      // A run that died after publishing leaves the new version but no item: count it once. Its
      // earlier values are gone, so the undo keeps this pass.
      const written = await hasVersionFrom(ctx.env.DB, pass.id, 'schedule', row.started_at ?? 0);
      return { ...base, outcome: written ? 'updated' : 'unchanged' };
    }
    const providers =
      plan.notify && !result.silenced
        ? budgetOutcomes(await providerBudgets(ctx, result.pass))
        : null;
    await recordPassEvent(ctx, {
      orgId: row.org_id,
      passId: pass.id,
      mode: row.mode,
      kind: 'schedule.applied',
      actor: actorOf(row),
      data: {
        broadcastId: row.id,
        notified: plan.notify && !result.silenced,
        overBudget: !!result.silenced,
        ...(providers ? { providers } : {}),
      },
    });
    return {
      ...base,
      outcome: 'updated',
      silent: !!result.silenced,
      before: seen.values ? JSON.stringify(seen.values) : null,
      version: result.pass.version,
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('broadcast.pass_failed', {
      broadcastId: row.id,
      passId: pass.id,
      code: error.code,
    });
    return { ...base, outcome: 'failed' };
  }
}
