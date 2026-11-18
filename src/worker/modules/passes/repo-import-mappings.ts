import { grant } from '../../platform/authority.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';

/** The plan last saved for a template of this org, as JSON. Plans are per org: a Test plan works in Live. */
export async function savedPlan(
  db: D1Database,
  orgId: string,
  templateId: string,
): Promise<string | null> {
  const row = await first<{ plan: string }>(
    db,
    'SELECT plan FROM pass_import_mappings WHERE org_id = ? AND template_id = ?',
    [orgId, templateId],
  );
  return row?.plan ?? null;
}

export async function savePlan(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  templateId: string,
  plan: string,
  by: string,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org.pass.import_mapping',
    principal: tenantPrincipal(authority),
    target: templateId,
    tables: ['pass_import_mappings'],
    checks: capabilityChecks(authority),
  });
  g.upsert(
    'pass_import_mappings',
    ['template_id', 'plan', 'updated_by', 'updated_at'],
    [templateId, plan, by, ctx.clock.now()],
    { update: ['plan', 'updated_by', 'updated_at'] },
  );
  await g.commit();
}
