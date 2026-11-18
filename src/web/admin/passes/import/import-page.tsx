import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { EmptyState, PageHeader } from '../../../ui/index.ts';
import { RecentImports } from './recent.tsx';
import { SourceStep } from './source-step.tsx';

const CRUMBS = [{ label: 'Passes', to: '/admin/passes' }, { label: 'Import' }];

/** Start an import and see the recent ones. */
export function ImportPage() {
  const { orgId, membership } = useOrgScope();
  const canOperate = membership?.capabilities.includes('passes:operate') ?? false;
  return (
    <>
      <PageHeader title={C.title} description={C.description} breadcrumbs={CRUMBS} />
      {!orgId ? (
        <EmptyState art="people" title={C.chooseOrg} />
      ) : !canOperate ? (
        <EmptyState art="lock" title={C.forbidden} />
      ) : (
        <div className="flex flex-col gap-6">
          <SourceStep orgId={orgId} />
          <RecentImports orgId={orgId} />
        </div>
      )}
    </>
  );
}
