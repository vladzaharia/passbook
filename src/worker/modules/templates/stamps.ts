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
import { latestVersionName } from './repo.ts';
import { stampHistogram, stampVersions } from './repo-stamps.ts';
import { loadTemplate, passUsageOrg } from './service-access.ts';

const cards = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;

const inputMax = (m: TemplateManifest): number | undefined => {
  const props = m.inputs?.properties as Record<string, { maximum?: unknown }> | undefined;
  const max = props?.[m.stamps?.input ?? '']?.maximum;
  return typeof max === 'number' ? max : undefined;
};

/**
 * The live cards of the scope as buckets, each read with its own version's input name and goal.
 * A version without stamps holds no cards that count.
 */
async function buckets(
  ctx: ServiceContext,
  registry: CompositeTemplateRegistry,
  q: { templateId: string; mode: Mode; orgId?: string | null },
): Promise<StampBucket[]> {
  const out: StampBucket[] = [];
  for (const version of await stampVersions(ctx.env.DB, q)) {
    const own = (await registry.resolve(q.templateId, version)).manifest.stamps;
    if (!own) continue;
    const rows = await stampHistogram(ctx.env.DB, { ...q, version, input: own.input });
    for (const r of rows) out.push({ ...r, goal: own.goal });
  }
  return out;
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
  const version = row.activeVersion ?? (await latestVersionName(ctx.env.DB, id));
  if (!version) throw new NotFoundError('Template has no saved version.', 'TEMPLATE_NOT_FOUND');
  if (!(await registry.resolve(id, version)).manifest.stamps)
    throw new ConflictError('This template has no stamps.', 'STAMPS_NONE');
  return goalImpact(
    await buckets(ctx, registry, {
      templateId: id,
      mode: modeOf(auth),
      orgId: passUsageOrg(auth, row.orgId, query.orgId),
    }),
    query.goal,
  );
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
  let above = 0;
  let highest = 0;
  for (const b of await buckets(ctx, registry, { templateId, ...scope })) {
    const next = countAfterGoalChange(
      b.stamps,
      b.goal,
      block.goal,
      block.keepReady === true,
      b.kept,
    );
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
