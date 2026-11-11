import { useEffect } from 'react';
import type { z } from 'zod';
import { isApiError } from '../../lib/errors.ts';
import { useOrgScope, useResourceOrg } from '../../lib/org-filter.tsx';
import {
  DetailNotFound,
  detailError,
  EmptyState,
  PageHeader,
  SkeletonDetail,
} from '../../ui/index.ts';
import { useTemplate } from './api.ts';
import { TemplateDetailContent } from './detail-content.tsx';
import type { templateDetailSearchSchema } from './search.ts';
import '../passes/passes.css';

type Search = z.infer<typeof templateDetailSearchSchema>;

export function TemplateDetailPage({ templateId, search }: { templateId: string; search: Search }) {
  const { hasExplicitOrg } = useOrgScope();
  return (
    <TemplateDetailResource
      key={JSON.stringify([templateId, hasExplicitOrg])}
      templateId={templateId}
      search={search}
    />
  );
}

function TemplateDetailResource({ templateId, search }: { templateId: string; search: Search }) {
  const scope = useOrgScope();
  const canFetch =
    !scope.isLoading &&
    !scope.isError &&
    (scope.hasExplicitOrg
      ? Boolean(scope.membership?.capabilities.includes('templates:read'))
      : scope.memberships.some((m) => m.capabilities.includes('templates:read')));
  const template = useTemplate(
    canFetch ? templateId : undefined,
    scope.hasExplicitOrg ? scope.orgId : undefined,
  );
  const fresh = scope.hasExplicitOrg || (template.isFetchedAfterMount && !template.isError);
  const resourceScope = useResourceOrg(fresh ? template.data?.orgId : undefined, true);
  useEffect(() => {
    if (
      canFetch &&
      !scope.hasExplicitOrg &&
      !template.isFetchedAfterMount &&
      !template.isFetching
    ) {
      void template.refetch();
    }
  }, [
    canFetch,
    scope.hasExplicitOrg,
    template.isFetchedAfterMount,
    template.isFetching,
    template.refetch,
  ]);
  const crumbs = [
    { label: 'Templates', to: '/admin/templates', search: { orgId: scope.orgId } },
    { label: 'Template' },
  ];
  if (!scope.isLoading && !canFetch) {
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }
  if (
    resourceScope === 'choose-org' ||
    (!scope.hasExplicitOrg &&
      template.isFetchedAfterMount &&
      isApiError(template.error) &&
      template.error.isForbidden)
  ) {
    return (
      <EmptyState
        heading
        art="building"
        title="Choose an organization"
        description="Choose an organization in the top bar to continue."
      />
    );
  }
  if (template.isError && (scope.hasExplicitOrg || template.isFetchedAfterMount)) {
    return detailError(template, {
      entity: 'template',
      to: '/admin/templates',
      header: <PageHeader title="Template" breadcrumbs={crumbs} />,
    });
  }
  if (resourceScope === 'pending' || !template.data)
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading template" />
      </>
    );
  if (
    resourceScope === 'not-found' ||
    !scope.orgId ||
    (template.data.orgId !== null && template.data.orgId !== scope.orgId)
  ) {
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }
  return (
    <TemplateDetailContent
      key={`${scope.orgId}:${template.data.id}`}
      template={template.data}
      tab={search.tab ?? 'overview'}
      crumbs={[
        { label: 'Templates', to: '/admin/templates', search: { orgId: scope.orgId } },
        { label: template.data.name },
      ]}
    />
  );
}
