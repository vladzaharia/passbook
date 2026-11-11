import { useRef } from 'react';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import { DetailNotFound, EmptyState, ErrorState, PageHeader, Skeleton } from '../../ui/index.ts';
import { useTemplate } from './api.ts';
import { UploadForm } from './upload-form.tsx';

export function TemplateUploadPage({
  templateId,
  upload: initialUpload,
}: {
  templateId?: string | undefined;
  upload?: string | undefined;
}) {
  const scope = useOrgScope();
  const { isAdmin } = useSession();
  const orgId =
    !scope.isLoading &&
    !scope.isError &&
    scope.membership?.capabilities.includes('templates:author')
      ? scope.orgId
      : undefined;
  const base = useTemplate(orgId ? templateId : undefined, orgId);
  const reopened = useRef<{ id: string; scope: string } | undefined>(undefined);
  if (!initialUpload) reopened.current = undefined;
  else if (orgId && reopened.current?.id !== initialUpload) {
    reopened.current = { id: initialUpload, scope: orgId };
  }
  const scopedUpload = reopened.current?.scope === orgId ? initialUpload : undefined;
  const header = <PageHeader title={templateId ? 'Template' : 'Upload template'} />;

  if (scope.isLoading) {
    return (
      <>
        {header}
        <Skeleton className="h-24 w-full" />
      </>
    );
  }
  if (!orgId) {
    return (
      <>
        {header}
        <EmptyState art="torn" title="Choose an authorized organization" />
      </>
    );
  }
  if (templateId && base.isError) {
    return (
      <>
        {header}
        <ErrorState
          error={base.error}
          title="Could not load the template"
          onRetry={() => void base.refetch()}
        />
      </>
    );
  }
  if (templateId && !base.data) {
    return (
      <>
        {header}
        <Skeleton className="h-24 w-full" />
      </>
    );
  }
  if (base.data && base.data.orgId !== null && base.data.orgId !== orgId) {
    return (
      <>
        {header}
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }
  if (base.data?.orgId === null && !isAdmin) {
    return (
      <>
        {header}
        <EmptyState
          art="lock"
          title="You do not have access"
          description="Only platform administrators can change a shared template."
        />
      </>
    );
  }
  return (
    <UploadForm
      key={`${orgId}:${templateId ?? ''}:${scopedUpload ?? ''}`}
      version={base.data}
      initialUpload={scopedUpload}
      selectedScope={orgId}
      memberships={scope.memberships}
      onScopeChange={scope.setOrgId}
    />
  );
}
