import type { OrgRole } from '../contracts/org-membership.ts';

/** What each role allows, one line, worded from its grants in `worker/platform/org-role-grants.ts`. */
export const ROLE_BLURBS: Record<OrgRole, string> = {
  org_admin: 'Everything, including members.',
  integration_admin: 'Connections and API keys.',
  template_author: 'Create and edit templates.',
  template_reviewer: 'Review templates.',
  template_publisher: 'Publish templates.',
  pass_operator: 'Issue and manage passes and messages.',
  read_only: 'View only.',
};

export const ROLE_NOTES = {
  org_admin: 'Organization admin covers every role.',
  read_only: 'Read only cannot combine with other roles.',
} as const;
