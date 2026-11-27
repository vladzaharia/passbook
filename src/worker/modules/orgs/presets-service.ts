import type {
  EntitlementPresetDto,
  SetEntitlementPresetInput,
  SetEntitlementPresetResult,
} from '../../../shared/contracts/entitlement-presets.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementValue,
  presetOrder,
  presetValues,
} from '../../../shared/contracts/entitlements.ts';
import { type EntitlementValues, entitlementImpact } from '../../../shared/entitlement-impact.ts';
import type { PlatformCaller } from '../../platform/actor.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor } from '../audit/service.ts';
import { onEntitlementsChanged } from '../channels/entitlement-apply.ts';
import { byUserOfCaller } from '../idp/actor.ts';
import { overrideMaps, parseStored, parseValuesJson } from './preset-values.ts';
import {
  presetRows,
  presetValueRows,
  storedOverrides,
  writeEntitlements,
} from './repo-entitlements.ts';
import { pendingCount, pendingCounts, pendingOrgs, writePreset } from './repo-presets.ts';
import { resolve } from './service-entitlements.ts';

/** Organizations one call moves: each is a grant, an audit row and a queue send. The rest wait for the next call. */
export const FANOUT_MAX = 50;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const changed = () =>
  new ConflictError('The preset changed. Reload and retry.', 'ENTITLEMENTS_CHANGED');

export async function loadPresetValues(
  ctx: ServiceContext,
): Promise<Map<string, EntitlementValues>> {
  const byPreset = new Map<string, EntitlementValues>();
  for (const v of await presetValueRows(ctx.env.DB)) {
    const key = ENTITLEMENT_KEYS.find((k) => k === v.key);
    const value = parseStored(ctx, v.key, v.value);
    if (key !== undefined && value !== undefined)
      byPreset.set(v.preset, { ...byPreset.get(v.preset), [key]: value });
  }
  return byPreset;
}

/** Platform: every preset with its values and how many organizations are on it. */
export async function listPresets(ctx: ServiceContext): Promise<EntitlementPresetDto[]> {
  const [rows, values, pending] = await Promise.all([
    presetRows(ctx.env.DB),
    loadPresetValues(ctx),
    pendingCounts(ctx.env.DB),
  ]);
  return [...rows]
    .sort((a, b) => presetOrder(a.preset, b.preset))
    .map((p) => ({
      preset: p.preset,
      label: p.label,
      revision: p.revision,
      updatedAt: p.updated_at,
      orgCount: p.shown_count,
      pendingOrgs: pending.get(p.preset) ?? 0,
      values: (values.get(p.preset) ?? {}) as Record<string, EntitlementValue>,
    }));
}

/** One organization moves with its preset: its revision, an audit row, and the channel runs the plan change asks for. */
async function moveOrg(
  ctx: ServiceContext,
  admin: PlatformCaller,
  by: string,
  actor: Actor,
  p: {
    preset: string;
    presetRevision: number;
    before: EntitlementValues;
    after: EntitlementValues;
  },
  org: { org_id: string; revision: number; preset_revision: number },
): Promise<boolean> {
  const now = ctx.clock.now();
  // The journal's before holds every stored override and its after the standing ones, so an override that
  // expired since the last tick is journaled here and removed with the move.
  const { all, standing, expired } = overrideMaps(
    ctx,
    await storedOverrides(ctx.env.DB, org.org_id),
    now,
  );
  // `previous_values` is one edit back. An org further behind (an org save raced two edits) has no recorded
  // before: journal it as a full re-evaluation from everything on, so every channel the plan blocks now is stopped.
  const gap = org.preset_revision < p.presetRevision - 1;
  if (gap)
    ctx.log.warn('entitlement.preset_gap', {
      orgId: org.org_id,
      preset: p.preset,
      code: 'PRESET_GAP',
      behind: p.presetRevision - org.preset_revision,
    });
  const was = resolve(gap ? presetValues('legacy') : p.before, all);
  const after = resolve(p.after, standing);
  const impact = entitlementImpact(was, after);
  const revision = org.revision + 1;
  try {
    await writeEntitlements(ctx, {
      orgId: org.org_id,
      admin,
      by,
      expectedRevision: org.revision,
      preset: p.preset,
      presetRevision: p.presetRevision,
      now,
      remove: expired,
      put: [],
      audit: {
        ...auditActor(actor),
        orgId: org.org_id,
        action: 'org.entitlements_update',
        targetType: 'org',
        targetId: org.org_id,
        detail: {
          via: 'preset',
          ...(gap ? { gap: true } : {}),
          preset: p.preset,
          changes: Object.fromEntries(
            impact.changes.map((c) => [
              c.key,
              { from: gap ? null : (c.from ?? null), to: c.to ?? null },
            ]),
          ),
          off: impact.counts.off,
          down: impact.counts.down,
          on: impact.counts.on,
          up: impact.counts.up,
          version: revision,
        },
      },
    });
  } catch (error) {
    // An org save landed in between: the org stays pending and the next call moves it.
    if (error instanceof ConflictError && error.code === 'ENTITLEMENTS_CHANGED') {
      ctx.log.info('org.preset_move_skipped', { orgId: org.org_id, code: 'ENTITLEMENTS_CHANGED' });
      return false;
    }
    throw error;
  }
  await onEntitlementsChanged(ctx, org.org_id, was, after, by, revision, gap);
  return true;
}

/**
 * Platform: changes values of one preset, then moves up to FANOUT_MAX organizations on it. A stale
 * `expectedRevision` is a 409 and nothing is written. While organizations still wait for an earlier edit, a new
 * change is refused (`PRESET_MOVING`); the same call with no values carries the move on. Turning a feature off
 * never deletes anything the org made (design-multi-tenancy.md M5).
 */
export async function setPreset(
  ctx: ServiceContext,
  actor: Actor,
  admin: PlatformCaller,
  input: SetEntitlementPresetInput,
  limit = FANOUT_MAX,
): Promise<SetEntitlementPresetResult> {
  const db = ctx.env.DB;
  const by = await byUserOfCaller(db, admin);
  const meta = (await presetRows(db)).find((p) => p.preset === input.preset);
  if (!meta) throw new NotFoundError('Preset not found.', 'PRESET_NOT_FOUND');
  if (input.expectedRevision !== meta.revision) throw changed();
  const current = (await loadPresetValues(ctx)).get(input.preset) ?? {};
  const edits = Object.entries(input.values).filter(
    ([key, value]) => !same(current[key as keyof EntitlementValues], value),
  );
  const waiting = await pendingCount(db, input.preset, meta.revision);
  if (waiting > 0 && meta.previous_values === null)
    throw new ConflictError(
      'This preset has no record of its last change. Ask an engineer to move its organizations.',
      'PRESET_MOVING',
    );
  let revision = meta.revision;
  let before = parseValuesJson(ctx, meta.previous_values);
  let after = current;
  if (edits.length > 0) {
    if (waiting > 0)
      throw new ConflictError(
        'Organizations are still moving to the last change. Apply it again first.',
        'PRESET_MOVING',
      );
    const now = ctx.clock.now();
    before = current;
    after = { ...current, ...Object.fromEntries(edits) };
    revision = meta.revision + 1;
    const impact = entitlementImpact(before, after);
    try {
      await writePreset(ctx, {
        admin,
        by,
        preset: input.preset,
        expectedRevision: meta.revision,
        now,
        previousValues: JSON.stringify(current),
        changes: edits.map(([key, value]) => ({ key, value: JSON.stringify(value) })),
        audit: {
          ...auditActor(actor),
          action: 'entitlement_preset.update',
          targetType: 'entitlement_preset',
          targetId: input.preset,
          detail: {
            changes: Object.fromEntries(
              edits.map(([key, value]) => [
                key,
                { from: current[key as keyof EntitlementValues] ?? null, to: value },
              ]),
            ),
            orgs: meta.org_count,
            off: impact.counts.off,
            down: impact.counts.down,
            on: impact.counts.on,
            up: impact.counts.up,
            version: revision,
          },
        },
      });
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'ENTITLEMENTS_CHANGED') throw changed();
      throw error;
    }
  } else if (waiting === 0) return { preset: await presetOf(ctx, input.preset), moved: 0 };

  let moved = 0;
  const move = { preset: input.preset, presetRevision: revision, before, after };
  for (const org of await pendingOrgs(db, input.preset, revision, limit)) {
    try {
      if (await moveOrg(ctx, admin, by, actor, move, org)) moved++;
    } catch (error) {
      // The edit is committed: report what moved, and the rest stays pending for the next call.
      ctx.log.error('entitlement.preset_move_failed', {
        orgId: org.org_id,
        preset: input.preset,
        code: 'PRESET_MOVE_FAILED',
        error,
      });
    }
  }
  ctx.log.info('entitlement.preset_set', { preset: input.preset, revision, moved });
  return { preset: await presetOf(ctx, input.preset), moved };
}

async function presetOf(ctx: ServiceContext, preset: string): Promise<EntitlementPresetDto> {
  const found = (await listPresets(ctx)).find((p) => p.preset === preset);
  if (!found) throw new NotFoundError('Preset not found.', 'PRESET_NOT_FOUND');
  return found;
}
