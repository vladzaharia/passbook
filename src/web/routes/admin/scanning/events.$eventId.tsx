import { createFileRoute } from '@tanstack/react-router';
import { legacySearch, redirectLegacy } from '../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/scanning/events/$eventId')({
  validateSearch: legacySearch,
  beforeLoad: redirectLegacy,
});
