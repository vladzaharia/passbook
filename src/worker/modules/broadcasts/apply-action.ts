import type { ChangeAction } from '../../../shared/contracts/broadcasts-change.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo.ts';
import { setPassStatus } from '../passes/service-status.ts';
import { releaseMovePlan, type StampMove } from '../passes/stamps-keep.ts';
import { activeRelease } from '../templates/releases.ts';
import { actorOf } from './actor.ts';
import { alreadyWritten, settlePending } from './change-intent.ts';
import { type BroadcastRow, type ItemRow, setIntent } from './repo.ts';
import { creatorLive, notWrittenYet } from './repo-creator.ts';

/** The approved design each template moves to, read once per chunk, with its stamp plan. */
export type DesignCache = Map<
  string,
  { id: string; generation: number; version: string; move: StampMove } | null
>;

const changed = () => new ConflictError('Pass no longer matches the change.', 'PASS_CONFLICT');

/**
 * Void and latest-design runs. Like an input change, every write re-proves the creator and re-checks
 * the pass inside the publish; the item keeps the status or version moved from and to. A void is
 * undoable (the item's version is the undo's fence); a move to the latest design is not, because a
 * pass can only be published onto the template's approved release.
 */
export async function applyAction(
  ctx: ServiceContext,
  row: BroadcastRow,
  action: ChangeAction,
  designs: DesignCache,
  pass: Pass,
): Promise<ItemRow | null> {
  const base = { passId: pass.id, silent: false };
  let release: { id: string; generation: number; version: string; move: StampMove } | null = null;
  if (action === 'design') {
    const key = pass.templateId;
    if (!designs.has(key)) {
      const active = await activeRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple');
      designs.set(
        key,
        active
          ? {
              id: active.id,
              generation: active.generation,
              version: active.version,
              move: await releaseMovePlan(ctx, {
                orgId: pass.orgId,
                mode: pass.mode,
                templateId: pass.templateId,
                version: active.version,
              }),
            }
          : null,
      );
    }
    release = designs.get(key) ?? null;
    if (!release) {
      ctx.log.warn('broadcast.pass_failed', {
        broadcastId: row.id,
        passId: pass.id,
        code: 'TEMPLATE_RELEASE_REQUIRED',
      });
      return { ...base, outcome: 'failed' };
    }
    if (release.version === pass.templateVersion) return { ...base, outcome: 'unchanged' };
  }
  const target = release;
  const seen: { from?: string } = {};
  await setIntent(
    ctx.env.DB,
    row.id,
    pass.id,
    JSON.stringify(
      target
        ? {
            action,
            from: { templateVersion: pass.templateVersion },
            to: { templateVersion: target.version },
            version: pass.version,
          }
        : { action, from: { status: 'active' }, to: { status: 'voided' }, version: pass.version },
    ),
  );
  try {
    const stillOurs = (current: Pass) => {
      if (
        current.orgId !== row.org_id ||
        current.mode !== row.mode ||
        current.status !== 'active' ||
        current.removedAt !== null
      )
        throw changed();
    };
    // A void is the platform's own void (events, audit row, print PDFs) with the run's creator proved in its write.
    const result = target
      ? await publishPass(ctx, {
          passId: pass.id,
          orgScope: row.org_id,
          cause: row.created_by_type === 'api_key' ? 'api' : 'admin',
          source: 'schedule',
          sourceRef: row.id,
          actor: actorOf(row),
          dispatch: false,
          // A design move tells holders only when the run says so.
          notify: row.notify === 1,
          extraChecks: [creatorLive(row, ctx.clock.now()), notWrittenYet(row.id, pass.id)],
          expectedRelease: { id: target.id, generation: target.generation },
          mutate: (current) => {
            stillOurs(current);
            seen.from = current.templateVersion;
            return { templateVersion: target.version, ...target.move(current) };
          },
        })
      : await setPassStatus(
          ctx,
          actorOf(row),
          pass.id,
          'voided',
          { orgId: row.org_id, mode: row.mode, principal: 'session' },
          undefined,
          {
            extraChecks: [creatorLive(row, ctx.clock.now()), notWrittenYet(row.id, pass.id)],
            source: 'schedule',
            sourceRef: row.id,
            notify: false,
            guard: stillOurs,
          },
        );
    // A build identical to the old one stores the version with no new pass version and no push.
    if (!result.changed) return { ...base, outcome: 'unchanged' };
    await recordPassEvent(ctx, {
      orgId: row.org_id,
      passId: pass.id,
      mode: row.mode,
      kind: 'schedule.applied',
      actor: actorOf(row),
      data: { broadcastId: row.id, notified: false, overBudget: !!result.silenced },
    });
    const moved =
      action === 'void'
        ? { action, from: { status: 'active' }, to: { status: 'voided' } }
        : {
            action,
            from: { templateVersion: seen.from ?? null },
            to: { templateVersion: target?.version ?? null },
          };
    return {
      ...base,
      outcome: 'updated',
      silent: !!result.silenced,
      before: JSON.stringify(moved),
      version: result.pass.version,
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // Refused because this run already wrote the pass (a newer attempt): settle that write, record no failure.
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
