import { createFileRoute } from '@tanstack/react-router';
import { carryOrgScope, legacySearch, redirectLegacy } from '../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/orgs/$orgId')({
  validateSearch: legacySearch,
  search: carryOrgScope,
  beforeLoad: redirectLegacy,
});
