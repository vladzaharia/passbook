import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type ConfigureWalletProviderAccount,
  type RevokeWalletProviderAccount,
  type WalletProvider,
  type WalletProviderReadiness,
  WalletProviderReadinessSchema,
  type WalletProviderScope,
} from '@/shared/contracts/wallet-providers.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { Button, ConfirmDialog, StatusPill } from '@/web/ui/index.ts';
import { WalletAccountCredentialsForm } from './wallet-accounts-fields.tsx';
import { headers, Retry, safeError } from './wallet-accounts-shared.tsx';

const ACCOUNTS_PATH = '/api/v1/wallet-providers/accounts';
const names: Record<WalletProvider, string> = {
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
};

function scopedReadiness(
  value: WalletProviderReadiness,
  scope: WalletProviderScope,
): WalletProviderReadiness {
  if (
    value.orgId !== scope.orgId ||
    value.mode !== scope.mode ||
    value.provider !== scope.provider
  ) {
    throw new Error('Wallet account response scope mismatch');
  }
  return value;
}

export function ProviderAccount({
  scope,
  canManage,
}: {
  scope: WalletProviderScope;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const key = ['wallet-accounts', scope.orgId, scope.mode, scope.provider] as const;
  const account = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      scopedReadiness(
        await api.get(ACCOUNTS_PATH, WalletProviderReadinessSchema, {
          query: scope,
          headers: headers(scope.mode),
          signal,
        }),
        scope,
      ),
  });
  const [edit, setEdit] = useState<{ revision: number; rotating: boolean } | null>(null);
  const [confirmRotation, setConfirmRotation] = useState<number | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const name = names[scope.provider];

  const refresh = () => client.invalidateQueries({ queryKey: key, exact: true });

  async function save(request: ConfigureWalletProviderAccount) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      scopedReadiness(
        await api.put(ACCOUNTS_PATH, WalletProviderReadinessSchema, request, {
          headers: headers(scope.mode),
        }),
        scope,
      );
      setEdit(null);
      await refresh();
      setNotice('Credentials saved.');
    } catch (cause) {
      setError(safeError(cause));
      if (isApiError(cause) && cause.isConflict) void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(revision: number) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const body: RevokeWalletProviderAccount = { ...scope, expectedRevision: revision };
      scopedReadiness(
        await api.post(`${ACCOUNTS_PATH}/revoke`, WalletProviderReadinessSchema, body, {
          headers: headers(scope.mode),
        }),
        scope,
      );
      await refresh();
      setNotice('Account revoked.');
    } catch (cause) {
      if (isApiError(cause) && cause.isConflict) void refresh();
      // ConfirmDialog may render thrown strings; return only our fixed, credential-free copy.
      throw safeError(cause);
    } finally {
      setBusy(false);
    }
  }

  const data = account.data;
  const configured = data !== undefined && data.state !== 'absent' && data.state !== 'revoked';
  const unavailable = busy || account.isFetching;
  return (
    <section aria-label={name} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold text-fg-strong">{name}</h3>
      {account.isPending ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading account…
        </p>
      ) : account.isError || !data ? (
        <Retry message={safeError(account.error)} onRetry={() => void account.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={data.state} tone={data.state === 'revoked' ? 'danger' : 'neutral'}>
              {data.state === 'absent'
                ? 'Not configured'
                : data.state === 'revoked'
                  ? 'Revoked'
                  : 'Configured'}
            </StatusPill>
            {data.updatedAt !== null ? (
              <span className="text-xs text-fg-muted">
                Updated {formatDateTime(data.updatedAt)}
              </span>
            ) : null}
          </div>
          {data.issuance.state === 'disabled' ? (
            <p className="text-sm text-fg-muted">Not available yet</p>
          ) : null}
          {edit && edit.revision !== data.revision ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-warning">
              <span>
                The account changed while you were editing. Reopen the form to review the current
                status.
              </span>
              <Button variant="outline" size="sm" onClick={() => setEdit(null)}>
                Close form
              </Button>
            </div>
          ) : edit && canManage ? (
            <WalletAccountCredentialsForm
              scope={scope}
              revision={edit.revision}
              rotating={edit.rotating}
              busy={unavailable}
              onSave={save}
              onCancel={() => {
                setEdit(null);
                setError('');
              }}
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-fg-strong">
              {notice}
            </p>
          ) : null}
          {!edit ? (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              {canManage ? (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={unavailable}
                    onClick={() => {
                      setError('');
                      setNotice('');
                      if (configured) setConfirmRotation(data.revision);
                      else setEdit({ revision: data.revision, rotating: false });
                    }}
                  >
                    {configured ? 'Rotate credentials' : 'Configure credentials'}
                  </Button>
                </div>
              ) : null}
              {canManage && configured ? (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={unavailable}
                    onClick={() => setConfirmRevoke(data.revision)}
                  >
                    Revoke account
                  </Button>
                </div>
              ) : null}
              {!canManage ? (
                <p className="text-sm text-fg-muted">
                  You have read-only access to wallet account settings.
                </p>
              ) : null}
            </div>
          ) : null}
          <ConfirmDialog
            open={confirmRotation !== null}
            onOpenChange={(open) => {
              if (!open) setConfirmRotation(null);
            }}
            title={`Rotate ${name} credentials?`}
            description="Replacement credentials take effect when saved."
            confirmLabel="Continue"
            confirmDisabled={unavailable || confirmRotation !== data.revision || !canManage}
            onConfirm={() => {
              if (confirmRotation === data.revision && canManage)
                setEdit({ revision: data.revision, rotating: true });
            }}
          />
          <ConfirmDialog
            open={confirmRevoke !== null}
            onOpenChange={(open) => {
              if (!open) setConfirmRevoke(null);
            }}
            title={`Revoke ${name} account?`}
            description="Retire linked wallet instances first. Copies already in a wallet are not removed."
            confirmLabel="Revoke account"
            destructive
            confirmDisabled={unavailable || confirmRevoke !== data.revision || !canManage}
            onConfirm={() => {
              if (confirmRevoke !== data.revision || !canManage)
                throw 'This account changed. Review its status again.';
              return revoke(data.revision);
            }}
          />
        </>
      )}
    </section>
  );
}
