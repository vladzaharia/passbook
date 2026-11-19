import { createFileRoute } from '@tanstack/react-router';
import { legacySearch, redirectLegacy } from '../../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/passes/import/$importId')({
  validateSearch: legacySearch,
  beforeLoad: redirectLegacy,
});
