import { Ban, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { revokeKeyConfirm } from '@/web/lib/confirms.ts';
import { orgPath, platformPath } from '@/web/lib/scope.ts';
import {
  Button,
  ConfirmDialog,
  DetailNotFound,
  detailError,
  EmptyState,
  ErrorState,
  SkeletonDetail,
  SkeletonRows,
  StatusPill,
  toast,
  useNow,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { useKeyActivity, useKeyChildren, useKeyDetail } from './detail-queries.ts';
import { STATE_TONE } from './key-columns.tsx';
import { AccessCard, ActivityCard, ChildrenCard } from './key-detail-cards.tsx';
import { KeysHeader, useKeysHost } from './keys-host.tsx';
import { keyState, useRevokeKey } from './queries.ts';
import { RotateDialog } from './rotate-dialog.tsx';
import type { KeyAccess } from './use-key-access.ts';

/** A key's page for a known access; the Workbench renders it with its own. */
export function KeyDetailView({ access, keyId }: { access: KeyAccess; keyId: string }) {
  if (access.state === 'loading') return <SkeletonRows label="Loading organization access" />;
  if (access.state === 'session-error')
    return <ErrorState subject="session" error={access.error} onRetry={access.retry} />;
  if (access.state === 'org-error')
    return <ErrorState subject="organization access" error={access.error} onRetry={access.retry} />;
  if (access.state === 'denied')
    return <EmptyState heading art="lock" title="You do not have access" />;
  return (
    <KeyDetail
      key={JSON.stringify([access.principal, access.orgId, keyId])}
      keyId={keyId}
      principal={access.principal}
      orgId={access.orgId}
      orgName={access.orgName}
      canManage={access.canManage}
      canAudit={access.canAudit}
    />
  );
}

function KeyDetail({
  keyId,
  principal,
  orgId,
  orgName,
  canManage,
  canAudit,
}: {
  keyId: string;
  principal: string;
  orgId: string | null;
  orgName: string;
  canManage: boolean;
  canAudit: boolean;
}) {
  const host = useKeysHost();
  const listPath =
    host?.listPath ?? (orgId === null ? platformPath('/api-keys') : orgPath(orgId, '/api-keys'));
  const detail = useKeyDetail(principal, orgId, keyId);
  const children = useKeyChildren(principal, orgId, keyId);
  // The audit log is read with audit:read, or for a member's own personal key.
  const own = detail.data?.kind === 'personal' && detail.data.createdBy === principal;
  const activity = useKeyActivity(principal, orgId, keyId, canAudit || own);
  const revoke = useRevokeKey(principal);
  const [rotating, setRotating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const now = useNow();
  const listCrumb = { label: 'API keys', to: listPath };

  if (detail.isPending) return <SkeletonDetail label="Loading API key" />;
  if (detail.isError)
    return detailError(detail, {
      entity: 'apiKey',
      to: listPath,
      header: <KeysHeader title="API key" breadcrumbs={[listCrumb, { label: 'API key' }]} />,
    });
  const key = detail.data;
  const crumbs = [listCrumb, { label: key.name }];
  if (key.orgId !== orgId)
    return (
      <>
        <KeysHeader title="API key" breadcrumbs={crumbs} />
        <DetailNotFound entity="apiKey" to={listPath} />
      </>
    );
  const state = keyState(key, now);
  const live = state === 'active';
  // A personal key is its member's to rotate; a platform key made before expiry and addresses were required is replaced, not rotated.
  const legacy = key.kind === 'platform' && (key.expiresAt === null || key.ipAllow.length === 0);
  const canRotate = live && !legacy && (own || (canManage && key.kind !== 'personal'));
  // Platform keys have no children; a personal or child key mints none.
  const mints = key.kind === 'service' && key.parentKeyId === null && key.orgId !== null;
  return (
    <>
      <KeysHeader
        title={key.name}
        breadcrumbs={crumbs}
        meta={
          <>
            <StatusPill status={state} tone={STATE_TONE[state]} />
            {key.mode === 'test' ? (
              <ModePill mode="test" />
            ) : (
              <span className="text-fg-muted">Live</span>
            )}
            {key.kind === 'service' ? null : (
              <span className="text-fg-muted">
                {key.kind === 'personal' ? 'Personal' : 'Platform'}
              </span>
            )}
          </>
        }
        actions={
          (canManage || own) && (live || state === 'retiring') ? (
            <>
              {canRotate ? (
                <Button
                  variant="outline"
                  iconStart={<RefreshCw aria-hidden />}
                  onClick={() => setRotating(true)}
                >
                  Rotate
                </Button>
              ) : null}
              <Button
                variant="outline"
                iconStart={<Ban aria-hidden />}
                onClick={() => setRevoking(true)}
              >
                Revoke
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <AccessCard detail={key} now={now} orgName={orgName} />
        {canAudit || own ? (
          <ActivityCard
            data={activity.data}
            now={now}
            loading={activity.isPending}
            error={activity.error}
            onRetry={() => void activity.refetch()}
          />
        ) : null}
        {host?.aside?.(key.id)}
        {mints ? (
          <div className="lg:col-span-2">
            <ChildrenCard
              keys={children.data?.items}
              now={now}
              orgId={orgId}
              loading={children.isPending}
              error={children.error}
              onRetry={() => void children.refetch()}
            />
          </div>
        ) : null}
      </div>
      <RotateDialog
        open={rotating}
        onOpenChange={setRotating}
        principal={principal}
        orgName={orgName}
        keyData={key}
        childCount={key.childCount}
      />
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        {...revokeKeyConfirm(key.name)}
        description={
          key.childCount > 0
            ? `Requests using this key fail at once, and so do its ${key.childCount} child keys. This cannot be undone.`
            : 'Requests using this key fail at once. This cannot be undone. Update consumers to a replacement first.'
        }
        destructive
        onConfirm={async () => {
          await revoke.mutateAsync({ id: key.id, orgId: key.orgId });
          toast.success('Key revoked');
        }}
      />
    </>
  );
}
