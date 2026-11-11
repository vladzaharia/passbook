import { useNavigate } from '@tanstack/react-router';
import { useOrgScope, useResourceOrg } from '../../../lib/org-filter.tsx';
import { DetailNotFound, detailError, PageHeader, SkeletonDetail } from '../../../ui/index.ts';
import { usePass } from '../api.ts';
import type { PassDetailSearch as Search } from './detail-types.ts';
import { LoadedPassDetail } from './loaded-pass-detail.tsx';
import '../passes.css';

export function PassDetailPage({ passId, search }: { passId: string; search: Search }) {
  const { hasExplicitOrg } = useOrgScope();
  return (
    <PassDetailContent
      key={`${passId}:${hasExplicitOrg ? 'scoped' : 'bare'}`}
      passId={passId}
      search={search}
      bare={!hasExplicitOrg}
    />
  );
}

function PassDetailContent({
  passId,
  search,
  bare,
}: {
  passId: string;
  search: Search;
  bare: boolean;
}) {
  const navigate = useNavigate({ from: '/admin/passes/$passId' });
  const scope = useOrgScope();
  const pass = usePass(passId, bare);
  // A bare deep link must use a newly authorized response, not an older cached pass.
  const checked = !bare || (pass.isFetchedAfterMount && !pass.isFetching);
  const resourceOrg = useResourceOrg(checked && !pass.isError ? pass.data?.orgId : undefined);
  const matchesScope = Boolean(
    resourceOrg === 'ready' &&
      !scope.isLoading &&
      !scope.isError &&
      scope.orgId &&
      pass.data?.orgId === scope.orgId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  const crumbs = [
    { label: 'Passes', to: '/admin/passes' },
    {
      label:
        !pass.isError && matchesScope && pass.data ? (pass.data.title ?? pass.data.serial) : 'Pass',
    },
  ];
  if (checked && pass.isError) {
    return detailError(pass, {
      entity: 'pass',
      to: '/admin/passes',
      header: <PageHeader title="Pass" breadcrumbs={crumbs} />,
    });
  }
  if (!pass.data || resourceOrg === 'pending') {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading pass" media="start" />
      </>
    );
  }
  if (!matchesScope) {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={crumbs} />
        <DetailNotFound entity="pass" to="/admin/passes" />
      </>
    );
  }
  return (
    <LoadedPassDetail
      pass={pass.data}
      search={search}
      crumbs={crumbs}
      canOperate={scope.membership?.capabilities.includes('passes:operate') ?? false}
      setSearch={(patch) =>
        void navigate({
          to: '.',
          search: (prev: Search) =>
            Object.fromEntries(
              Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined),
            ),
          replace: true,
        })
      }
    />
  );
}
