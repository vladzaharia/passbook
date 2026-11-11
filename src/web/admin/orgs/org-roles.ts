import type { OrgRole } from '@/shared/contracts/org-membership.ts';

export const ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: 'Organization admin',
  integration_admin: 'Integration admin',
  template_author: 'Template author',
  template_reviewer: 'Template reviewer',
  template_publisher: 'Template publisher',
  pass_operator: 'Pass operator',
  read_only: 'Read only',
};
export const ROLES = Object.keys(ROLE_LABELS) as OrgRole[];
