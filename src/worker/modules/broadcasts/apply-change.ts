import type { Personalization } from '../../../passkit/types.ts';
import type { PatchOp } from '../../../shared/contracts/broadcasts-change.ts';
import {
  type ChangeAction,
  changeActionOf,
  changeOpsOf,
} from '../../../shared/contracts/broadcasts-change.ts';
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
import { applyAction, type DesignCache } from './apply-action.ts';
import { alreadyWritten, settlePending } from './change-intent.ts';
import { fillTokens, resolveOps } from './change-ops.ts';
import { type BroadcastRow, type ItemRow, setIntent } from './repo.ts';
import { creatorLive, notWrittenYet } from './repo-creator.ts';
import { StoredBroadcastTargetSchema } from './stored-target.ts';

/** A change run read once per chunk: the ops, and the text with its tokens. */
export interface ChangePlan {
  ops: Record<string, PatchOp>;
  /** Void or latest design, instead of ops. */
  action: ChangeAction | null;
  text: string | undefined;
  notify: boolean;
  /** The org's effective zone, read once per chunk: dates in the text read in it. */
  timeZone: string;
}

export const planOf = (row: BroadcastRow, timeZone: string): ChangePlan =>
  row.kind === 'change'
    ? {
        ops: changeOpsOf(JSON.parse(row.patch) as Record<string, Json>).ops,
        action: changeActionOf(JSON.parse(row.patch) as Record<string, Json>),
        text:
          row.notify === 1
            ? StoredBroadcastTargetSchema.parse(JSON.parse(row.target)).message
            : undefined,
        notify: row.notify === 1,
        timeZone,
      }
    : { ops: {}, action: null, text: undefined, notify: false, timeZone };

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
  next: Readonly<Record<string, Json | undefined>>,
): string | undefined {
  if (!plan.text) return undefined;
  return fillTokens(plan.text, (label) => {
    const f = t.fields.find((x) => x.label.toLowerCase() === label.toLowerCase());
    return f ? formatValue(next[f.key] ?? null, f, { timeZone: plan.timeZone }) : null;
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
  designs: DesignCache,
): Promise<ItemRow | null> {
  if (plan.action) return applyAction(ctx, row, plan.action, designs, pass);
  const base = { passId: pass.id, silent: false };
  const template = await fieldsOf(ctx, cache, pass);
  const first = resolveOps(plan.ops, pass.personalization, plan.timeZone);
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
  await setIntent(
    ctx.env.DB,
    row.id,
    pass.id,
    JSON.stringify({ from: first.from, to: first.to, version: pass.version }),
  );
  const seen: { values?: { from: Record<string, Json>; to: Record<string, Json> } } = {};
  try {
    const result = await publishPass(ctx, {
      passId: pass.id,
      orgScope: row.org_id,
      cause: row.created_by_type === 'api_key' ? 'api' : 'admin',
      source: 'schedule',
      sourceRef: row.id,
      actor: actorOf(row),
      dispatch: false,
      notify: plan.notify,
      // Read from the values the write finally carries, which a racing edit may have moved.
      ...(plan.text
        ? { changeText: (next: Personalization) => textFor(plan, template, next) ?? '' }
        : {}),
      extraChecks: [creatorLive(row, ctx.clock.now()), notWrittenYet(row.id, pass.id)],
      mutate: (current) => {
        // The pass may have changed since selection; this reruns on each retry of the write.
        if (
          current.orgId !== row.org_id ||
          current.mode !== row.mode ||
          current.status !== 'active' ||
          current.removedAt !== null
        )
          throw refused('PASS_CHANGED');
        const again = resolveOps(plan.ops, current.personalization, plan.timeZone);
        if (!again.ok) throw refused(again.code);
        seen.values = { from: again.from, to: again.to };
        return { personalization: again.next };
      },
    });
    const moved =
      seen.values && JSON.stringify(seen.values.from) !== JSON.stringify(seen.values.to);
    if (!result.changed) {
      // An input no field renders is stored with no new version and no push; it still counts as updated
      // (as when settled after a crash), and its earlier values are kept so the undo restores it.
      if (moved)
        return {
          ...base,
          outcome: 'updated',
          before: JSON.stringify(seen.values),
          version: result.pass.version,
        };
      // Settling a step that died after its write finds it by its stamp (change-intent.ts).
      return { ...base, outcome: 'unchanged' };
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
    // The write was refused because this run already wrote the pass (a newer attempt of this step):
    // settle that write's item instead of recording a failure over it.
    if (await alreadyWritten(ctx.env.DB, row.id, pass.id)) {
      await settlePending(ctx, row, pass.id);
      return null;
    }
    ctx.log.warn('broadcast.pass_failed', {
      broadcastId: row.id,
      passId: pass.id,
      code: error.code,
    });
    return { ...base, outcome: 'failed' };
  }
}
