import type { Group, GroupMember, GroupRule } from '../../../shared/contracts/idp-access.ts';
import type { GroupMemberRow } from './repo-group-members.ts';
import type { RuleRow } from './repo-group-rules.ts';
import type { ManagedGroup } from './types.ts';

export const toGroup = (g: ManagedGroup, sources?: { rules: number; manual: number }): Group => ({
  key: g.key,
  kind: g.kind,
  name: g.name,
  friendlyName: g.friendlyName,
  members: g.members,
  claims: g.claims,
  otherClients: g.otherClients,
  flags: g.flags,
  rules: sources?.rules ?? 0,
  manual: sources?.manual ?? 0,
});

export const toRule = (r: RuleRow): GroupRule => ({
  id: r.id,
  orgId: r.org_id,
  orgRoles: r.org_roles ? (JSON.parse(r.org_roles) as GroupRule['orgRoles']) : null,
  createdAt: r.created_at,
});

export const toMember = (m: GroupMemberRow): GroupMember => ({
  id: m.id,
  subject: m.subject,
  userId: m.user_id,
  source: m.source,
  createdAt: m.created_at,
});
