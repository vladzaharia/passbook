import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import { TemplateScanSetupSchema } from '@/shared/contracts/scan-template-setup.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { localZone } from '../../lib/timezones.ts';
import { toast } from '../../ui/index.ts';
import { markCreated } from '../passes/created.tsx';
import { scanningKeys } from '../scanning/queries.ts';
import { sessionKeys } from '../scanning/sessions/api.ts';
import { scanSetupSummary } from './scan-setup.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** Scan passes: one call makes the events and the session, then the session opens to pair a scanner. */
export function useScanPasses(t: Template) {
  const scope = useOrgScope();
  const client = useQueryClient();
  const navigate = useNavigate();
  const orgId = scope.orgId;
  const canScan = Boolean(
    orgId &&
      scope.membership?.capabilities.includes('scanning:manage') &&
      !t.blueprint &&
      t.status === 'active' &&
      t.activeVersion !== null,
  );
  const make = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/templates/${t.id}/scan-setup`, TemplateScanSetupSchema, {
        orgId,
        timeZone: localZone(),
      }),
    onSuccess: async (made) => {
      markCreated(`scan-setup:${made.session.id}`, scanSetupSummary(made));
      await Promise.all([
        client.invalidateQueries({ queryKey: sessionKeys.all }),
        client.invalidateQueries({ queryKey: scanningKeys.all }),
      ]);
      if (orgId)
        void navigate({
          to: '/admin/o/$orgId/scanning/sessions/$sessionId',
          params: { orgId, sessionId: made.session.id },
          search: { addDevice: '1' },
        });
    },
    onError: (error) => toast.error(error, 'Could not set up scanning'),
  });
  return { canScan, scan: () => make.mutate(), pending: make.isPending };
}
