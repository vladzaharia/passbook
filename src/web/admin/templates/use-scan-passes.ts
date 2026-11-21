import { useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;

/** Scan passes: the guided setup opens as Event night with this template's passes filled in. */
export function useScanPasses(t: Template) {
  const scope = useOrgScope();
  const navigate = useNavigate();
  const orgId = scope.orgId;
  const canScan = Boolean(
    orgId &&
      scope.membership?.capabilities.includes('scanning:manage') &&
      !t.blueprint &&
      t.status === 'active' &&
      t.activeVersion !== null,
  );
  const scan = () => {
    if (!orgId) return;
    void navigate({
      to: '/admin/o/$orgId/scanning/setup',
      params: { orgId },
      search: { preset: 'event_night', fromTemplate: t.id },
    });
  };
  return { canScan, scan, pending: false };
}
