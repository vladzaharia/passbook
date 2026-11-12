import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  type ScanningSession,
  ScanningSessionDetailSchema,
} from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { useOrgScope, useResourceOrg } from '@/web/lib/org-filter.tsx';
import { DetailNotFound, detailError, PageHeader, SkeletonDetail } from '@/web/ui/index.ts';
import { sessionKeys } from './api.ts';
import { SessionDetail } from './session-detail.tsx';
import { NewSessionDialog } from './session-dialog.tsx';

export function ScanningSessionPage({
  sessionId,
  deviceId,
  addDevice = false,
}: {
  sessionId: string;
  deviceId?: string;
  addDevice?: boolean;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const [duplicate, setDuplicate] = useState<ScanningSession>();
  const canManage = Boolean(
    scope.orgId && scope.membership?.capabilities.includes('scanning:manage'),
  );
  useEffect(() => {
    if (!scope.isLoading && (scope.isError || !canManage)) setDuplicate(undefined);
  }, [canManage, scope.isError, scope.isLoading]);
  return (
    <>
      <SessionResource
        key={`${sessionId}:${scope.hasExplicitOrg}:${scope.requestedOrgId ?? ''}`}
        sessionId={sessionId}
        deviceId={deviceId}
        addDevice={addDevice}
        onDuplicate={setDuplicate}
      />
      {canManage && duplicate ? (
        <NewSessionDialog
          initial={duplicate}
          onClose={() => setDuplicate(undefined)}
          onCreated={(id) => {
            setDuplicate(undefined);
            void navigate({
              to: '/admin/scanning/sessions/$sessionId',
              params: { sessionId: id },
              search: { orgId: scope.orgId },
            });
          }}
        />
      ) : null}
    </>
  );
}

function SessionResource({
  sessionId,
  deviceId,
  addDevice,
  onDuplicate,
}: {
  sessionId: string;
  deviceId: string | undefined;
  addDevice: boolean;
  onDuplicate: (session: ScanningSession) => void;
}) {
  const scope = useOrgScope();
  const query = useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/scanning-sessions/${sessionId}`, ScanningSessionDetailSchema, { signal }),
    refetchInterval: 5_000,
    refetchOnMount: 'always',
  });
  const s = query.data;
  const resourceScope = useResourceOrg(
    query.isFetchedAfterMount && !query.isError ? s?.orgId : undefined,
  );
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: 'Session' }];
  const header = <PageHeader title="Scanning session" breadcrumbs={crumbs} />;
  if (resourceScope === 'not-found') {
    return (
      <>
        {header}
        <DetailNotFound entity="scanner" to="/admin/scanning" back="scanning" />
      </>
    );
  }
  if (query.isError) {
    return detailError(query, {
      entity: 'scanner',
      to: '/admin/scanning',
      back: 'scanning',
      header,
    });
  }
  if (!s || resourceScope !== 'ready' || scope.orgId !== s.orgId) {
    return (
      <>
        {header}
        <SkeletonDetail label="Loading scanning session" />
      </>
    );
  }
  const canManage = Boolean(scope.membership?.capabilities.includes('scanning:manage'));
  return (
    <SessionDetail
      key={`${s.id}:${s.orgId}:${canManage}`}
      session={s}
      deviceId={deviceId}
      addDevice={addDevice}
      canManage={canManage}
      onDuplicate={onDuplicate}
    />
  );
}
