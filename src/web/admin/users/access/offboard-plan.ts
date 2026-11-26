import type { OffboardPlan } from '@/shared/contracts/idp-access.ts';
import { IDP_COPY, idpPlural } from '@/shared/copy/idp.ts';

const orgs = (list: { org: { name: string } }[]) => list.map((o) => o.org.name).join(', ');

/** The plan as lines: what ends, what Polaris ID loses, what stays. The real run ends exactly these. */
export function planLines(plan: OffboardPlan): string[] {
  const lines: string[] = [];
  if (plan.memberships.length)
    lines.push(
      `Leaves ${idpPlural(plan.memberships.length, 'organization')}: ${orgs(plan.memberships)}`,
    );
  if (plan.kept.length) lines.push(`Stays in inactive ${orgs(plan.kept)}`);
  if (plan.sponsorships.length)
    lines.push(`Developer sponsorship ends: ${orgs(plan.sponsorships)}`);
  if (plan.grants.length) lines.push(`Platform access ends: ${plan.grants.join(', ')}`);
  const keys = plan.personalKeys + plan.platformKeys.length;
  if (keys) lines.push(`${idpPlural(keys, 'API key')} revoked`);
  if (plan.sessions) lines.push(`${idpPlural(plan.sessions, 'session')} ended`);
  if (plan.sandboxOrgId) lines.push('Sandbox closed');
  if (plan.removes.length)
    lines.push(`Removed in Polaris ID: ${plan.removes.map((r) => IDP_COPY.role[r]).join(', ')}`);
  if (plan.external.length)
    lines.push(
      `Added in Polaris ID, left alone: ${plan.external.map((r) => IDP_COPY.role[r]).join(', ')}`,
    );
  lines.push('Account disabled');
  return lines;
}
