import { createFileRoute } from '@tanstack/react-router';
import { legacySearch, redirectLegacy } from '../../../lib/legacy-admin.ts';

export const Route = createFileRoute('/admin/scanning/scanners/$scannerId')({
  validateSearch: legacySearch,
  beforeLoad: redirectLegacy,
});
