import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import {
  WORKBENCH_TOOLS,
  type WorkbenchContexts,
} from '../../../shared/contracts/workbench-read.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { homeSandboxOf } from '../developer/repo-home.ts';
import { listMyOrgMemberships } from '../orgs/access.ts';
import { testCapableOrg } from './context.ts';

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
  const orgs: WorkbenchContexts['orgs'] = [];
  for (const m of memberships) {
    if (m.testOnly) continue;
    const access = await testCapableOrg(ctx, session.userId, m.orgId);
    if (!access) continue;
    orgs.push({
      orgId: m.orgId,
      name: m.orgName,
      slug: m.orgSlug,
      tools: WORKBENCH_TOOLS.filter((t) => access.capabilities.includes(TOOL_CAPABILITY[t])),
    });
  }
  return {
    sandbox: sandbox
      ? {
          orgId: sandbox.org_id,
          name: sandbox.name,
          slug: sandbox.slug,
          closed: sandbox.closed_at !== null,
        }
      : null,
    orgs,
  };
}
