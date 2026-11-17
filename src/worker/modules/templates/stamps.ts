import type { z } from 'zod';
import {
  countAfterGoalChange,
  goalImpact,
  type StampBucket,
} from '../../../passkit/stamps/rules.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  StampsImpactQuerySchema,
  StampsImpactSchema,
} from '../../../shared/contracts/stamps.ts';
import { type AuthContext, modeOf } from '../../platform/auth.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type CompositeTemplateRegistry, createTemplateRegistry } from './registry.ts';
import { listVersions } from './repo.ts';
import { type StampRow, stampHistogram } from './repo-stamps.ts';
import { loadTemplate, passUsageOrg } from './service-access.ts';

const cards = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;

const inputMax = (m: TemplateManifest): number | undefined => {
  const props = m.inputs?.properties as Record<string, { maximum?: unknown }> | undefined;
  const max = props?.[m.stamps?.input ?? '']?.maximum;
  return typeof max === 'number' ? max : undefined;
};

/** Each row with the goal of the version it sits on; a version without stamps never reads ready. */
async function withGoals(
  registry: CompositeTemplateRegistry,
  templateId: string,
  rows: readonly StampRow[],
): Promise<StampBucket[]> {
  const goals = new Map<string, number>();
  for (const version of new Set(rows.map((r) => r.version))) {
    const goal = (await registry.resolve(templateId, version)).manifest.stamps?.goal;
    goals.set(version, goal ?? Number.POSITIVE_INFINITY);
  }
  return rows.map((r) => ({ stamps: r.stamps, cards: r.cards, goal: goals.get(r.version) ?? 0 }));
}

/** What changing the goal of the template's current version to `goal` does to the live cards. */
export async function stampsImpact(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  query: z.infer<typeof StampsImpactQuerySchema>,
): Promise<z.infer<typeof StampsImpactSchema>> {
  const row = await loadTemplate(ctx, auth, id, query.orgId);
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const version = row.activeVersion ?? (await listVersions(ctx.env.DB, id))[0]?.version;
  if (!version) throw new NotFoundError('Template has no saved version.', 'TEMPLATE_NOT_FOUND');
  const block = (await registry.resolve(id, version)).manifest.stamps;
  if (!block) throw new ConflictError('This template has no stamps.', 'STAMPS_NONE');
  const rows = await stampHistogram(ctx.env.DB, {
    templateId: id,
    input: block.input,
    mode: modeOf(auth),
    orgId: passUsageOrg(auth, row.orgId, query.orgId),
  });
  return goalImpact(await withGoals(registry, id, rows), query.goal);
}

/**
 * Refuses releasing a version whose stamps maximum is below a live count, so the reissue never
 * fails INVALID_INPUT. With `keepReady`, ready cards move up with the goal; their new count counts.
 */
export async function assertStampsFit(
  ctx: ServiceContext,
  templateId: string,
  scope: { orgId: string; mode: Mode },
  manifest: TemplateManifest,
): Promise<void> {
  const block = manifest.stamps;
  const max = inputMax(manifest);
  if (!block || max === undefined) return;
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const rows = await stampHistogram(ctx.env.DB, { templateId, input: block.input, ...scope });
  let above = 0;
  let highest = 0;
  for (const b of await withGoals(registry, templateId, rows)) {
    const next = countAfterGoalChange(b.stamps, b.goal, block.goal, block.keepReady === true);
    highest = Math.max(highest, next);
    if (next > max) above += b.cards;
  }
  if (above > 0)
    throw new ConflictError(
      `${cards(above)} ${above === 1 ? 'has' : 'have'} more than ${max} stamps. Raise the maximum to ${highest} in the designer.`,
      'STAMPS_ABOVE_MAX',
    );
}

/** The manifest editor cannot redraw strips: a change to the block goes through the designer. */
export function assertStampsUnchanged(before: TemplateManifest, after: unknown): void {
  const next = (after as { stamps?: unknown } | null)?.stamps;
  if (JSON.stringify(before.stamps ?? null) !== JSON.stringify(next ?? null))
    throw new ConflictError('Change stamps in the designer.', 'STAMPS_REDRAW');
}
