import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import {
  WORKBENCH_TOOLS,
  type WorkbenchContexts,
} from '../../../shared/contracts/workbench-read.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { batch } from '../../platform/db.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { homeSandboxOf } from '../developer/repo-home.ts';
import { listMyOrgMemberships } from '../orgs/access.ts';
import { orgTimeZoneOf, orgTimeZoneStmt } from '../scan/repo-org-clock.ts';
import { testCapableOrg } from './context.ts';
import { devicePassEnabled } from './device-pass-identity.ts';

type Tool = (typeof WORKBENCH_TOOLS)[number];

/** What a role must read for each tool to show in an organization. */
const TOOL_CAPABILITY: Record<Tool, OrgCapability> = {
  home: 'org:read',
  design: 'templates:read',
  passes: 'passes:read',
  console: 'org:read',
  logs: 'passes:read',
  events: 'integrations:read',
  inbox: 'passes:read',
  activity: 'org:read',
  keys: 'org:read',
};

/** The sandbox, and each organization where this person may use Test, with the tools their roles read there. */
export async function workbenchContexts(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<WorkbenchContexts> {
  const [sandbox, memberships] = await Promise.all([
    homeSandboxOf(ctx.env.DB, session.userId),
    listMyOrgMemberships(ctx, session.userId),
  ]);
  const entries: { m: (typeof memberships)[number]; tools: Tool[] }[] = [];
  for (const m of memberships) {
    if (m.testOnly) continue;
    const access = await testCapableOrg(ctx, session.userId, m.orgId);
    if (!access) continue;
    // Member Workbench tokens need the org's `api` level; without it the org offers no tools here.
    if (!isEntitled(await entitlementsOf(ctx, m.orgId), 'api', 'read')) continue;
    entries.push({
      m,
      tools: WORKBENCH_TOOLS.filter((t) => access.capabilities.includes(TOOL_CAPABILITY[t])),
    });
  }
  // One batch for every zone, the sandbox's first.
  const zones = await batch(ctx.env.DB, [
    ...(sandbox ? [orgTimeZoneStmt(ctx.env.DB, sandbox.org_id)] : []),
    ...entries.map(({ m }) => orgTimeZoneStmt(ctx.env.DB, m.orgId)),
  ]);
  const offset = sandbox ? 1 : 0;
  const orgs: WorkbenchContexts['orgs'] = entries.map(({ m, tools }, i) => ({
    orgId: m.orgId,
    name: m.orgName,
    slug: m.orgSlug,
    timeZone: orgTimeZoneOf(zones[offset + i]),
    tools,
  }));
  return {
    sandbox: sandbox
      ? {
          orgId: sandbox.org_id,
          name: sandbox.name,
          slug: sandbox.slug,
          closed: sandbox.closed_at !== null,
          timeZone: orgTimeZoneOf(zones[0]),
          devicePass: devicePassEnabled(ctx.env),
        }
      : null,
    orgs,
  };
}
