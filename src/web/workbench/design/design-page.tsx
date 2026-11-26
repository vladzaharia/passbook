import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { wbPath } from '@/shared/workbench.ts';
import type { DesignSearch } from '../../admin/templates/designer/design-search.ts';
import { DesignerSkeleton } from '../../admin/templates/designer/designer-skeleton.tsx';
import {
  DesignerHostProvider,
  useDesignerHost,
  useHostKey,
} from '../../admin/templates/designer/host.tsx';
import {
  useWorkbenchDesignerHost,
  type WorkbenchClient,
} from '../../admin/templates/designer/hosts.tsx';
import { templateKeys } from '../../admin/templates/keys.ts';
import { useSession } from '../../lib/session.ts';
import { detailError } from '../../ui/detail-error.tsx';
import { DetailNotFound } from '../../ui/empty-state.tsx';
import { workbenchToken } from '../host/token.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { useToolApi } from '../host/tool-scope.ts';
import { ToolPage } from '../shell/tool-page.tsx';
import { DesignLoaded } from './design-loaded.tsx';
import { DESIGN_EXTRAS } from './extras.tsx';
import './design.css';

function TemplateResource({
  templateId,
  view,
  onView,
}: {
  templateId: string;
  view: DesignSearch;
  onView: (next: DesignSearch) => void;
}) {
  const api = useToolApi();
  const hostKey = useHostKey();
  const { orgId } = useDesignerHost();
  const template = useQuery({
    queryKey: [...templateKeys.detail(templateId, orgId), ...hostKey],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${encodeURIComponent(templateId)}`, TemplateDetailSchema, {
        query: { orgId },
        signal,
      }),
  });
  if (template.isError)
    return detailError(template, {
      entity: 'template',
      to: wbPath(orgId ?? '', 'design'),
    });
  if (!template.data) return <DesignerSkeleton />;
  // An org's own template only: a template of another org is not found here.
  if (template.data.orgId !== null && template.data.orgId !== orgId)
    return <DetailNotFound entity="template" to={wbPath(orgId ?? '', 'design')} heading />;
  return (
    <DesignLoaded
      key={`${orgId}:${template.data.id}`}
      template={template.data}
      view={view}
      onView={onView}
    />
  );
}

/**
 * `/workbench/o/$orgId/design/$templateId` (design §1.8): the one pass designer on the Workbench
 * host: Test only, every call and file on the token, release to Test, test passes from the Test
 * release. Admin keeps its own page on the same core.
 */
export function DesignPage({
  templateId,
  view,
  onView,
}: {
  templateId: string;
  view: DesignSearch;
  onView: (next: DesignSearch) => void;
}) {
  const host = useToolHost();
  const csrf = useSession().authed?.csrfToken;
  const { orgId } = host.context;
  const client = useMemo<WorkbenchClient>(
    () => ({
      kind: 'workbench-token',
      api: host.api,
      token: () => workbenchToken(orgId, csrf ?? ''),
    }),
    [host.api, orgId, csrf],
  );
  const designerHost = useWorkbenchDesignerHost({
    orgId,
    orgName: host.context.name,
    client,
    extras: DESIGN_EXTRAS,
  });
  return (
    <ToolPage tool="design">
      <div className="wb-tool-design">
        <DesignerHostProvider host={designerHost}>
          <TemplateResource templateId={templateId} view={view} onView={onView} />
        </DesignerHostProvider>
      </div>
    </ToolPage>
  );
}
