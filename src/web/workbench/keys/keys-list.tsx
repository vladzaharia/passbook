import { Plus } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiKeySchema } from '@/shared/contracts/api-keys.ts';
import { keyPrefix } from '../../admin/api-keys/key-columns.tsx';
import {
  KeysHeader,
  type KeysHost,
  KeysHostProvider,
  useKeysHost,
} from '../../admin/api-keys/keys-host.tsx';
import { type ApiKey, keyState, useApiKeyPages } from '../../admin/api-keys/queries.ts';
import type { KeyAccess } from '../../admin/api-keys/use-key-access.ts';
import { useToolApi } from '../../lib/tool-api.tsx';
import './keys-list.css';
import { Button, EmptyState, ErrorState, RowLink, SkeletonRows } from '../../ui/index.ts';
import { BenchList } from '../bench/list.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { StatusChip, type StatusTone } from '../bench/status-chip.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';

const KeyDetailView = lazy(() =>
  import('../../admin/api-keys/key-detail-page.tsx').then((m) => ({ default: m.KeyDetailView })),
);
/** The wizard loads when it is first opened: a list that is only read never pays for it. */
const CreateKeyDialog = lazy(() =>
  import('../../admin/api-keys/create-key-dialog.tsx').then((m) => ({
    default: m.CreateKeyDialog,
  })),
);

const TONE: Record<ReturnType<typeof keyState>, StatusTone> = {
  active: 'success',
  retiring: 'warning',
  expired: 'warning',
  retired: 'neutral',
  revoked: 'neutral',
};
const idOf = (k: ApiKey) => k.id;

/**
 * Keys on the bench: the org's Test keys in the one list, the opened key's page in the one pane
 * (`#<keyId>`; a drawer or sheet below 1180 px). Making, rotating and revoking are admin's own
 * components on the Workbench token.
 */
export function KeysSplit({
  access,
  createRequested,
  onCreateRequestHandled,
}: {
  access: KeyAccess;
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const canManage = access.state === 'ready' && access.canManage;
  useEffect(() => {
    if (createRequested && access.state !== 'loading' && access.state !== 'org-error' && !canManage)
      onCreateRequestHandled();
  }, [createRequested, access.state, canManage, onCreateRequestHandled]);
  if (access.state === 'loading') return <SkeletonRows label="Loading organization access" />;
  if (access.state === 'session-error')
    return <ErrorState subject="session" error={access.error} onRetry={access.retry} />;
  if (access.state === 'org-error')
    return <ErrorState subject="organization access" error={access.error} onRetry={access.retry} />;
  if (access.state === 'denied')
    return <EmptyState heading art="lock" title="You do not have access" />;
  return (
    <ScopedKeys
      key={JSON.stringify([access.principal, access.orgId, canManage])}
      access={access}
      createRequested={createRequested}
      onCreateRequestHandled={onCreateRequestHandled}
    />
  );
}

function ScopedKeys({
  access,
  createRequested,
  onCreateRequestHandled,
}: {
  access: Extract<KeyAccess, { state: 'ready' }>;
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const { principal, orgId, orgName, canManage } = access;
  const host = useKeysHost();
  const api = useToolApi();
  const [creating, setCreating] = useState(false);
  const [wizardLoaded, setWizardLoaded] = useState(false);
  useEffect(() => {
    if (creating) setWizardLoaded(true);
  }, [creating]);
  useEffect(() => {
    if (!createRequested || !canManage) return;
    setCreating(true);
    onCreateRequestHandled();
  }, [createRequested, canManage, onCreateRequestHandled]);
  const live = useApiKeyPages(principal, orgId, 'live');
  const items = useMemo(
    () => (live.data?.pages.flatMap((p) => p.items) ?? []).filter((k) => k.orgId === orgId),
    [live.data, orgId],
  );
  // A key the list does not hold (a child, a revoked one) is read by id and pinned on top.
  const fetchOne = useCallback(
    (id: string) =>
      api
        .get(`/api/v1/api-keys/${encodeURIComponent(id)}`, ApiKeySchema, { query: { orgId } })
        .catch(() => null),
    [api, orgId],
  );
  const selection = useBenchSelection({
    items,
    idOf,
    fetchOne,
    ready: !live.isPending,
  });
  const { select, selectedId } = selection;

  const now = Date.now();
  const create = (variant: 'primary' | 'outline') =>
    canManage ? (
      <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
        New API key
      </Button>
    ) : null;
  const empty = !live.isPending && !live.isError && items.length === 0;
  const head = <KeysHeader title="API keys" actions={empty ? undefined : create('primary')} />;
  if (live.isError && items.length === 0)
    return (
      <>
        {head}
        <ErrorState error={live.error} onRetry={() => live.refetch()} />
      </>
    );
  if (live.isPending)
    return (
      <>
        {head}
        <SkeletonRows label="Loading API keys" />
      </>
    );
  const list = (
    <BenchList
      label="API keys"
      items={items}
      idOf={idOf}
      row={(k) => ({
        title: (
          <>
            {k.name}
            {host?.own?.(k) ? <span className="wb-keys-own"> In use</span> : null}
          </>
        ),
        meta: <code>{keyPrefix(k)}</code>,
        trail: <StatusChip tone={TONE[keyState(k, now)]}>{keyState(k, now)}</StatusChip>,
      })}
      tone={(k) => TONE[keyState(k, now)]}
      selection={selection}
      empty={<EmptyState art="key" title="No API keys" action={create('primary')} />}
      footer={{
        count: `${items.length} ${items.length === 1 ? 'key' : 'keys'}`,
        onMore: live.hasNextPage ? () => void live.fetchNextPage() : undefined,
        loading: live.isFetchingNextPage,
      }}
    />
  );
  // The key's page sits in the pane: no back link, and a key it links to (a child) opens in place.
  const inPane: KeysHost | null = host && {
    ...host,
    embedded: true,
    keyLink: (_org, id, children) => (
      <RowLink
        to="/workbench/o/$orgId/keys"
        params={{ orgId: access.orgId ?? '' }}
        hash={id}
        onClick={(e) => {
          e.preventDefault();
          select(id);
        }}
      >
        {children}
      </RowLink>
    ),
  };
  const pane = selectedId ? (
    <div className="wb-keys-pane">
      <KeysHostProvider value={inPane}>
        <Suspense fallback={<SkeletonRows label="Loading API key" />}>
          <KeyDetailView access={access} keyId={selectedId} />
        </Suspense>
      </KeysHostProvider>
    </div>
  ) : (
    <p className="wb-keys-none">Select a key</p>
  );
  return (
    <>
      {head}
      {empty ? (
        list
      ) : (
        <BenchSplit
          main={list}
          pane={pane}
          open={selection.open && selectedId !== null}
          onClose={() => selection.setOpen(false)}
          label="API key"
        />
      )}
      {wizardLoaded ? (
        <Suspense fallback={null}>
          <CreateKeyDialog
            open={creating}
            onOpenChange={setCreating}
            principal={principal}
            orgId={orgId}
            orgName={orgName}
            capabilities={access.capabilities}
            developerOrg={access.developerOrg}
            idp={access.idp}
          />
        </Suspense>
      ) : null}
    </>
  );
}
