import type { z } from 'zod';
import type {
  OrgEntitlementsDto,
  SetOrgEntitlementsSchema,
} from '../../../shared/contracts/entitlement-admin.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementValue,
  presetOrder,
  presetValues,
} from '../../../shared/contracts/entitlements.ts';
import { type EntitlementValues, entitlementImpact } from '../../../shared/entitlement-impact.ts';
import type { PlatformCaller } from '../../platform/actor.ts';
import type { Actor } from '../../platform/context.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor } from '../audit/service.ts';
import { onEntitlementsChanged } from '../channels/entitlement-apply.ts';
import { byUserOfCaller } from '../idp/actor.ts';
import { assertFooterAllowed } from './footer-rule.ts';
import { overrideMaps, parseStored, parseValuesJson } from './preset-values.ts';
import {
  orgEntitlementsRow,
  orgExists,
  orgIsDeveloper,
  presetRows,
  presetValueRows,
  standingOverrides,
  storedOverrides,
  writeEntitlements,
} from './repo-entitlements.ts';

type Input = z.output<typeof SetOrgEntitlementsSchema>;
type Override = NonNullable<Input['overrides'][string]>;

const notFound = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
const changed = () =>
  new ConflictError('The features changed. Reload and retry.', 'ENTITLEMENTS_CHANGED');

interface State {
  /** Null for an org with no row. */
  preset: string | null;
  presetLabel: string | null;
  /** 0 for an org with no row. */
  revision: number;
  updatedAt: number | null;
  /** The preset as it stood before an edit that has not reached the org yet; null once it has. */
  lagging: EntitlementValues | null;
  /** More than one preset edit behind: `previous_values` is not its real before (journaled as a full re-evaluation). */
  gap: boolean;
  presets: {
    preset: string;
    label: string;
    revision: number;
    orgCount: number;
    values: EntitlementValues;
  }[];
  presetValues: EntitlementValues;
  overrides: Map<
    string,
    { value: EntitlementValue; note: string | null; expiresAt: number | null }
  >;
}

async function stateOf(ctx: ServiceContext, orgId: string): Promise<State> {
  const db = ctx.env.DB;
  if (!(await orgExists(db, orgId))) throw notFound();
  const row = await orgEntitlementsRow(db, orgId);
  const [allPresets, developer, values, stored] = await Promise.all([
    presetRows(db),
    orgIsDeveloper(db, orgId),
    presetValueRows(db),
    standingOverrides(db, orgId, ctx.clock.now()),
  ]);
  const presets = allPresets.filter((p) => (p.preset === 'developer') === developer);
  const byPreset = new Map<string, EntitlementValues>();
  for (const v of values) {
    const known = ENTITLEMENT_KEYS.find((k) => k === v.key);
    const value = parseStored(ctx, v.key, v.value);
    if (known === undefined || value === undefined) continue;
    byPreset.set(v.preset, { ...byPreset.get(v.preset), [known]: value });
  }
  const list = presets
    .map((p) => ({
      preset: p.preset,
      label: p.label,
      revision: p.revision,
      orgCount: p.shown_count,
      values: byPreset.get(p.preset) ?? {},
    }))
    .sort((a, b) => presetOrder(a.preset, b.preset));
  const current = row ? list.find((p) => p.preset === row.preset) : undefined;
  const overrides = new Map<
    string,
    { value: EntitlementValue; note: string | null; expiresAt: number | null }
  >();
  for (const o of row ? stored : []) {
    const value = parseStored(ctx, o.key, o.value);
    if (value !== undefined) overrides.set(o.key, { value, note: o.note, expiresAt: o.expires_at });
  }
  return {
    preset: row?.preset ?? null,
    presetLabel: row ? (current?.label ?? row.preset) : null,
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? null,
    lagging:
      row && current && row.preset_revision < current.revision
        ? parseValuesJson(
            ctx,
            allPresets.find((p) => p.preset === row.preset)?.previous_values ?? null,
          )
        : null,
    gap: !!(row && current && row.preset_revision < current.revision - 1),
    presets: list,
    presetValues: current?.values ?? {},
    overrides,
  };
}

/** The resolved values: the preset's, with a standing override over any key the preset carries. */
export function resolve(
  presetValues: EntitlementValues,
  overrides: ReadonlyMap<string, { value: EntitlementValue }>,
): EntitlementValues {
  const out: EntitlementValues = {};
  for (const key of ENTITLEMENT_KEYS) {
    const base = presetValues[key];
    if (base === undefined) continue;
    out[key] = overrides.get(key)?.value ?? base;
  }
  return out;
}

/** Platform: the preset, every resolved feature with its source, and the presets to pick from. */
export async function readOrgEntitlements(
  ctx: ServiceContext,
  orgId: string,
): Promise<OrgEntitlementsDto> {
  const s = await stateOf(ctx, orgId);
  const items: OrgEntitlementsDto['items'] = [];
  for (const key of ENTITLEMENT_KEYS) {
    const presetValue = s.presetValues[key];
    if (presetValue === undefined) continue;
    const o = s.overrides.get(key);
    items.push({
      key,
      value: o?.value ?? presetValue,
      presetValue,
      source: o ? 'override' : 'preset',
      note: o?.note ?? null,
      expiresAt: o?.expiresAt ?? null,
    });
  }
  return {
    orgId,
    preset: s.preset,
    presetLabel: s.presetLabel,
    revision: s.revision,
    updatedAt: s.updatedAt,
    items,
    presets: s.presets.map(({ revision: _revision, ...p }) => ({
      ...p,
      values: p.values as Record<string, EntitlementValue>,
    })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkOverrides(now: number, overrides: Input['overrides']): void {
  for (const [key, o] of Object.entries(overrides)) {
    if (o?.expiresAt != null && o.expiresAt <= now)
      throw new ValidationError('Invalid request.', [
        { path: `overrides.${key}.expiresAt`, message: 'Choose a time in the future.' },
      ]);
  }
}

/**
 * Platform: sets the preset and the overrides in one write. `expectedRevision` is the revision the caller
 * read; a stale one is a 409 and nothing is written. A request that changes nothing writes nothing.
 * Turning a feature off never deletes anything the org made (design-multi-tenancy.md M5).
 */
export async function setOrgEntitlements(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  input: Input,
  admin: PlatformCaller,
): Promise<OrgEntitlementsDto> {
  const now = ctx.clock.now();
  const by = await byUserOfCaller(ctx.env.DB, admin);
  const before = await stateOf(ctx, orgId);
  const target = before.presets.find((p) => p.preset === input.preset);
  if (!target)
    throw new ValidationError('Invalid request.', [
      { path: 'preset', message: 'Choose one of the presets.' },
    ]);
  if (input.expectedRevision !== before.revision) throw changed();
  checkOverrides(now, input.overrides);

  const next = new Map<string, Override>();
  for (const [key, o] of Object.entries(input.overrides)) if (o) next.set(key, o);
  const standing = (key: string) => before.overrides.get(key);
  const put = [...next].filter(([key, o]) => {
    const was = standing(key);
    return (
      !was || !same(was.value, o.value) || was.note !== o.note || was.expiresAt !== o.expiresAt
    );
  });
  const stored = await storedOverrides(ctx.env.DB, orgId);
  const remove = stored.map((o) => o.key).filter((key) => !next.has(key));
  const create = before.preset === null;
  const noOp = !create && input.preset === before.preset && put.length === 0 && remove.length === 0;
  if (noOp) return readOrgEntitlements(ctx, orgId);

  const base = before.gap ? presetValues('legacy') : (before.lagging ?? before.presetValues);
  const was = resolve(base, overrideMaps(ctx, stored, now).all);
  const after = resolve(target.values, next);
  assertFooterAllowed(input.preset, after['brand.mark']);
  const impact = entitlementImpact(was, after);
  const touched = new Set([...put.map(([k]) => k), ...remove, ...impact.changes.map((c) => c.key)]);
  const changes: Record<string, unknown> = {};
  for (const key of ENTITLEMENT_KEYS.filter((k) => touched.has(k))) {
    const o = next.get(key);
    changes[key] = {
      from: before.gap ? null : (was[key] ?? null),
      to: after[key] ?? null,
      ...(o?.note ? { note: o.note } : {}),
      ...(o?.expiresAt != null ? { expiresAt: o.expiresAt } : {}),
      ...(o ? {} : standing(key) ? { override: 'removed' } : {}),
    };
  }
  try {
    await writeEntitlements(ctx, {
      orgId,
      admin,
      by,
      expectedRevision: before.revision,
      preset: input.preset,
      presetRevision: target.revision,
      now,
      remove,
      put: put.map(([key, o]) => ({
        key,
        value: JSON.stringify(o.value),
        note: o.note,
        expiresAt: o.expiresAt,
      })),
      audit: {
        ...auditActor(actor),
        orgId,
        action: 'org.entitlements_update',
        targetType: 'org',
        targetId: orgId,
        detail: {
          ...(input.preset === before.preset
            ? {}
            : { preset: { from: before.preset, to: input.preset } }),
          ...(create ? { created: true } : {}),
          ...(before.gap ? { gap: true } : {}),
          changes,
          off: impact.counts.off,
          down: impact.counts.down,
          on: impact.counts.on,
          up: impact.counts.up,
          version: before.revision + 1,
        },
      },
    });
  } catch (error) {
    // A save that landed between the read and the write moves `revision`: the batch aborted whole.
    // Two repairs of a row-less org race on the insert: the loser hits the primary key.
    if (error instanceof ConflictError && error.code === 'ENTITLEMENTS_CHANGED') throw changed();
    if (classifyD1Error(error)?.kind === 'unique') throw changed();
    throw error;
  }
  // Delivery channels the plan gates converge their passes: one channel-apply run per template.
  await onEntitlementsChanged(ctx, orgId, was, after, by, before.revision + 1, before.gap);
  ctx.log.info('org.entitlements_set', { orgId, preset: input.preset });
  return readOrgEntitlements(ctx, orgId);
}
