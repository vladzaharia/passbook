import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { WorkbenchSummarySchema } from '@/shared/contracts/workbench-read.ts';
import {
  type OutboundHost,
  OutboundWizard,
} from '../../admin/connections/webhooks/outbound-wizard.tsx';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { useEventsApi } from './use-events.ts';

/** The context's templates for the endpoint's template filter, on the Test token. A refusal hides the filter's list. */
function useWorkbenchTemplates(selected: boolean) {
  const api = useToolApi();
  const key = useToolKey();
  const { orgId } = useToolHost().context;
  const q = useQuery({
    queryKey: ['workbench', 'events', 'templates', orgId, ...key],
    queryFn: () =>
      api.get('/api/v1/templates', TemplateListSchema, { query: { orgId, limit: 200 } }),
    enabled: selected,
    retry: false,
  });
  return { canList: !q.isError, items: q.data?.items ?? [], loading: q.isPending && selected };
}

/**
 * The Connections wizard's outbound path, mounted in the Workbench: locked to this context's Test,
 * no organization chooser, calls on the token. It is its own lazy chunk, opened by Add endpoint.
 */
export default function AddEndpointWizard({
  open,
  onOpenChange,
  onFinish,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinish: (endpoint: WebhookEndpointDto) => void;
}) {
  const { context } = useToolHost();
  const api = useEventsApi();
  const tool = useToolApi();
  const key = useToolKey();
  const sandbox = context.kind === 'sandbox';
  const summary = useQuery({
    queryKey: ['workbench', 'events', 'quota', context.orgId, ...key],
    queryFn: () =>
      tool.get('/api/v1/workbench/summary', WorkbenchSummarySchema, {
        query: { orgId: context.orgId },
      }),
    enabled: open && sandbox,
  });
  const quota = summary.data?.quotas?.endpoints ?? null;
  const host = useMemo<OutboundHost>(
    () => ({
      sandbox,
      quota,
      useTemplateChoices: useWorkbenchTemplates,
      ensureCapture: async () => (await api.ensureCapture()).endpoint,
      onFinish,
    }),
    [sandbox, quota, api, onFinish],
  );
  return <OutboundWizard open={open} onOpenChange={onOpenChange} host={host} />;
}
