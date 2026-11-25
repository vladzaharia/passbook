import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { EmptyState, PageHeader } from '../../../ui/index.ts';
import { RecentImports } from './recent.tsx';
import { SourceStep } from './source-step.tsx';

const CRUMBS = [{ label: 'Passes', to: '/admin/passes' }, { label: 'Import' }];

/** Start an import and see the recent ones. */
export function ImportPage() {
  const { orgId, membership } = useOrgScope();
  const canOperate = membership?.capabilities.includes('passes:operate') ?? false;
  if (!orgId) return <OrgChooser title={C.chooseOrg} />;
  return (
    <>
      <PageHeader title={C.title} breadcrumbs={CRUMBS} />
      {!canOperate ? (
        <EmptyState art="lock" title={C.forbidden} />
      ) : (
        <SourceStep orgId={orgId}>
          <RecentImports orgId={orgId} />
        </SourceStep>
      )}
    </>
  );
}
