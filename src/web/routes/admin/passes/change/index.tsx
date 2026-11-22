import { createFileRoute } from '@tanstack/react-router';
import { carryOrgScope, legacySearch, redirectLegacy } from '../../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/passes/change/')({
  validateSearch: legacySearch,
  search: carryOrgScope,
  beforeLoad: redirectLegacy,
});
