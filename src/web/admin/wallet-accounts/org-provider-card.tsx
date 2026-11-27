import { CircleCheck, CircleDashed } from 'lucide-react';
import { useState } from 'react';
import type { WalletCredential, WalletEnrolment } from '@/shared/contracts/wallet-providers.ts';
import { reissueWalletPassesConfirm } from '@/web/lib/confirms-wallet.ts';
import { useMode } from '@/web/lib/mode.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  SegmentedControl,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { walletNote } from '../operations/notes.ts';
import { OperationSlot } from '../operations/operation-slot.tsx';
import { COPY, PROVIDER_NAME, releaseLine, safeError } from './copy.ts';
import { CredentialRow } from './credential-row.tsx';
import { blockerOf, gatesOf } from './gates.ts';
import { useWalletActions } from './queries.ts';
import { WalletHealthPanel } from './wallet-health.tsx';

type Source = NonNullable<WalletEnrolment['source']>;

function StatePill({ e }: { e: WalletEnrolment }) {
  if (e.state === 'on')
    return (
      <StatusPill status="on" tone="success">
        On
      </StatusPill>
    );
  if (e.state === 'held')
    return (
      <StatusPill status="held" tone="warning">
        Held
      </StatusPill>
    );
  if (e.state === 'revoked') return <StatusPill status="revoked" />;
  return (
    <StatusPill status="off" tone="neutral">
      Off
    </StatusPill>
  );
}

/** One wallet in the organization's current mode: source, own credentials and what is left before it can turn on. */
export function OrgProviderCard({
  orgId,
  enrolment: e,
  own,
  canManage,
  canReissue,
}: {
  orgId: string;
  enrolment: WalletEnrolment;
  /** The organization's active own credential for this mode and provider. */
  own: WalletCredential | undefined;
  canManage: boolean;
  /** passes:operate: sending every copy again is a pass action, not an account one. */
  canReissue: boolean;
}) {
  const mode = useMode();
  const actions = useWalletActions();
  const [busy, setBusy] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const name = PROVIDER_NAME[e.provider];
  const on = e.state === 'on';
  const blocker = blockerOf(e);
  const notReleased = releaseLine(e.provider, e.issuance) ?? undefined;
  const help = e.state === 'held' || on ? undefined : blocker;
  const revoked = e.state === 'revoked';

  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await work();
      if (done) toast.success(done);
    } catch (cause) {
      toast.error(safeError(cause), 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const sources = [
    {
      value: 'platform' as const,
      label: COPY.platformSource,
      disabled: !e.platformAvailable,
      title: e.platformAvailable ? undefined : COPY.noPlatform,
    },
    {
      value: 'org' as const,
      label: COPY.ownSource,
      disabled: own === undefined,
      title: own === undefined ? COPY.noOwn : undefined,
    },
  ];
  const sourceHelp =
    !e.platformAvailable && own === undefined
      ? `${COPY.noPlatform} ${COPY.noOwn}`
      : !e.platformAvailable
        ? COPY.noPlatform
        : own === undefined
          ? COPY.noOwn
          : null;

  return (
    <Card aria-label={name} role="region">
      <CardHeader
        as="h2"
        title={`${name} · ${mode === 'test' ? 'Test' : 'Live'}`}
        actions={<StatePill e={e} />}
      />
      <CardBody className="flex flex-col gap-5">
        {e.state === 'held' ? (
          <Callout tone="warning" title="Held by PassBook">
            {e.hold?.reason || 'No reason given.'}
          </Callout>
        ) : null}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg-strong">Account</p>
          <SegmentedControl
            label={`${name} account`}
            options={sources.map((o) => (revoked ? { ...o, disabled: true } : o))}
            value={e.source ?? ('' as Source)}
            onValueChange={(next) => {
              if (!canManage || busy || revoked || next === e.source) return;
              void run(
                () => actions.setSource(orgId, e, next),
                on ? COPY.sourceSwitchedOff : undefined,
              );
            }}
          />
          {sourceHelp ? <p className="text-xs text-fg-muted">{sourceHelp}</p> : null}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg-strong">Own credentials</p>
          <CredentialRow
            target={{ kind: 'org', orgId }}
            provider={e.provider}
            credential={own}
            canManage={canManage}
            fresh={e.source === 'org' ? e.prerequisites.check : undefined}
            issuance={e.issuance}
          />
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {notReleased && e.state !== 'held' ? (
            <p className="text-sm text-fg-muted">{notReleased}</p>
          ) : null}
          {help ? <p className="text-sm text-fg-muted">{help}</p> : null}
          <ul aria-label="Before it can be allowed" className="flex flex-col gap-1 text-sm">
            {gatesOf(e).map((g) => (
              <li key={g.label} className="flex items-center gap-2 text-fg-muted">
                {g.ok ? (
                  <CircleCheck aria-hidden className="size-4 text-success" />
                ) : (
                  <CircleDashed aria-hidden className="size-4" />
                )}
                <span>
                  {g.label}: {g.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <WalletHealthPanel orgId={orgId} provider={e.provider} canOperate={canReissue} />
        <OperationSlot
          kind="wallet.reissue"
          orgId={orgId}
          startedId={updating}
          onClear={() => setUpdating(null)}
          doneNote={walletNote}
        />
        {canReissue && on ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button size="sm" variant="outline" onClick={() => setReissuing(true)}>
              {COPY.reissue}
            </Button>
          </div>
        ) : null}
        <ConfirmDialog
          open={reissuing}
          onOpenChange={setReissuing}
          {...reissueWalletPassesConfirm(name)}
          onConfirm={async () => {
            let result: { instances: number; operationId: string | null };
            try {
              result = await actions.reissue(orgId, e.provider);
            } catch (cause) {
              throw safeError(cause);
            }
            if (result.operationId) setUpdating(result.operationId);
            else toast.success('Nothing to update yet');
          }}
        />
        {canManage ? null : <p className="text-sm text-fg-muted">{COPY.readOnly}</p>}
      </CardBody>
    </Card>
  );
}
