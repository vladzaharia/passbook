import { createFileRoute } from '@tanstack/react-router';
import { legacySearch, redirectLegacy } from '../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/templates/$templateId_/design')({
  validateSearch: legacySearch,
  beforeLoad: redirectLegacy,
});
