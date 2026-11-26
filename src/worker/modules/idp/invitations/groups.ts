import { ruleSourcesForRoles } from '../repo-sources.ts';
import type { GroupKey, SignupKind, SignupSpec, Target } from '../types.ts';
import type { Invite } from './resolve.ts';

/** Signup tokens carry at most this many custom groups (the binding refuses more). */
const MAX_GROUPS = 5;

const ROLES_OF: Record<SignupKind, Target[]> = {
  member: ['console'],
  developer: ['developer'],
  member_developer: ['developer', 'console'],
  platform: [],
};

/**
 * What the invitation puts a person in, from the row alone: console for a membership, developer for developer
 * access, and the custom groups whose org rules the invited roles meet at this moment. More than five rules'
 * groups are cut to the first five; the drain adds the rest once the membership exists.
 */
export async function signupSpecOf(db: D1Database, invite: Invite): Promise<SignupSpec> {
  const kind: SignupKind =
    invite.kind === 'member'
      ? 'member'
      : invite.row.member_id !== null
        ? 'member_developer'
        : 'developer';
  const rules =
    invite.row.member_roles === null
      ? []
      : await ruleSourcesForRoles(db, invite.row.org_id, invite.row.member_roles);
  const groups: GroupKey[] = [...new Set(rules.map((r) => r.group_key))].slice(0, MAX_GROUPS);
  return groups.length ? { kind, groups } : { kind };
}

/** The targets a spec stands for: what an existing account is given at once when it claims the invitation. */
export const targetsOfSpec = (spec: SignupSpec): Target[] => [
  ...ROLES_OF[spec.kind],
  ...(spec.groups ?? []).map((key): Target => `g:${key}`),
];
