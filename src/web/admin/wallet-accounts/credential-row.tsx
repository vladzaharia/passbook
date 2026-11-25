import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { WalletCredential, WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { revokeWalletCredentialConfirm } from '@/web/lib/confirms-wallet.ts';
import { ApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Button, ConfirmDialog, StatusPill, toast } from '@/web/ui/index.ts';
import { checkFresh } from './check.ts';
import { CHECK_WAIT, COPY, checkWords, PROVIDER_NAME, safeError } from './copy.ts';
import { CredentialDialog } from './credential-dialog.tsx';
import { type CredentialTarget, isAbort, useCheckCredential, useWalletActions } from './queries.ts';

/** The latest check a credential shows, passed or failed; verifiedAt only gates enrolment. */
export function CheckPill({
  credential,
  fresh,
}: {
  credential: WalletCredential;
  /** The server's freshness for the enrolment's source, when this is that credential. */
  fresh?: boolean;
}) {
  const last = credential.lastCheck;
  if (!last) return <StatusPill status="not_checked" />;
  if (!last.ok)
    return <StatusPill status="failed">Check failed {formatDateTime(last.at)}</StatusPill>;
  return checkFresh(last.at, Date.now(), fresh) ? (
    <StatusPill status="verified">Checked {formatDateTime(last.at)}</StatusPill>
  ) : (
    <StatusPill status="not_checked" tone="warning">
      Last checked {formatDateTime(last.at)}
    </StatusPill>
  );
}

/** One credential slot: its hint and check, or the add button; rotate and revoke for managers. */
export function CredentialRow({
  target,
  provider,
  credential,
  canManage,
  label,
  fresh,
}: {
  target: CredentialTarget;
  provider: WalletProvider;
  credential: WalletCredential | undefined;
  canManage: boolean;
  /** Names the slot when a page lists several (Live, Test). */
  label?: string;
  /** The server's check freshness, when this credential is an enrolment's source. */
  fresh?: boolean;
}) {
  const actions = useWalletActions();
  const sessionMode = useMode();
  const runCheck = useCheckCredential();
  const [checking, setChecking] = useState(false);
  async function check(c: WalletCredential) {
    setChecking(true);
    try {
      const result = await runCheck(target, c);
      if (result.status === 'ok') toast.success('Check passed');
      else if (result.status !== 'failed')
        toast.info('The check is still running. Reload in a moment.');
    } catch (cause) {
      if (isAbort(cause)) return;
      toast.error(
        cause instanceof ApiError && cause.status === 429 ? CHECK_WAIT : safeError(cause),
        'Could not check',
      );
    } finally {
      setChecking(false);
    }
  }
  const mode = target.kind === 'platform' ? target.mode : sessionMode;
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <KeyRound aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 text-sm">
          {label ? <p className="font-medium text-fg-strong">{label}</p> : null}
          {credential ? (
            <p className="flex flex-wrap items-center gap-2 text-fg-muted">
              <span className="font-mono text-xs">…{credential.identityHint}</span>
              <CheckPill credential={credential} fresh={fresh} />
            </p>
          ) : (
            <p className="text-fg-muted">No credentials</p>
          )}
          {credential?.lastCheck && !credential.lastCheck.ok ? (
            <p role="alert" className="mt-1 text-danger">
              {checkWords(credential.lastCheck.code)}
            </p>
          ) : null}
        </div>
      </div>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {credential ? (
            <Button
              size="sm"
              variant="outline"
              loading={checking}
              onClick={() => void check(credential)}
            >
              Check
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {credential ? COPY.rotate : COPY.addCredentials}
          </Button>
          {credential ? (
            <Button size="sm" variant="outline" onClick={() => setRevoking(true)}>
              {COPY.revoke}
            </Button>
          ) : null}
        </div>
      ) : null}
      <CredentialDialog
        provider={provider}
        modeLabel={mode === 'test' ? 'Test' : 'Live'}
        revision={credential?.revision ?? 0}
        rotating={credential !== undefined}
        open={open}
        onOpenChange={setOpen}
        save={(body) => actions.saveCredential(target, body)}
      />
      {credential ? (
        <ConfirmDialog
          open={revoking}
          onOpenChange={setRevoking}
          {...revokeWalletCredentialConfirm(PROVIDER_NAME[provider])}
          destructive
          onConfirm={async () => {
            try {
              await actions.revokeCredential(target, credential);
            } catch (cause) {
              throw safeError(cause);
            }
            toast.success('Credentials revoked');
          }}
        />
      ) : null}
    </div>
  );
}
