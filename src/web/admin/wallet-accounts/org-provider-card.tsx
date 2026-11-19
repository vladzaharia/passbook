import { CircleCheck, CircleDashed } from 'lucide-react';
import { useState } from 'react';
import type { WalletCredential, WalletEnrolment } from '@/shared/contracts/wallet-providers.ts';
import { useMode } from '@/web/lib/mode.ts';
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  SegmentedControl,
  StatusPill,
  SwitchRow,
  toast,
} from '@/web/ui/index.ts';
import { COPY, PROVIDER_NAME, safeError } from './copy.ts';
import { CredentialRow } from './credential-row.tsx';
import { blockerOf, gatesOf } from './gates.ts';
import { useWalletActions } from './queries.ts';

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

/** One wallet in the organization's current mode: source, own credentials, and the switch. */
export function OrgProviderCard({
  orgId,
  enrolment: e,
  own,
  canManage,
}: {
  orgId: string;
  enrolment: WalletEnrolment;
  /** The organization's active own credential for this mode and provider. */
  own: WalletCredential | undefined;
  canManage: boolean;
}) {
  const mode = useMode();
  const actions = useWalletActions();
  const [busy, setBusy] = useState(false);
  const name = PROVIDER_NAME[e.provider];
  const blocker = blockerOf(e);
  const on = e.state === 'on';
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
          />
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <SwitchRow
            label={`${name} on`}
            help={
              e.state === 'held'
                ? undefined
                : on
                  ? e.issuance.state === 'disabled'
                    ? COPY.notReleased
                    : undefined
                  : (blocker ?? (e.issuance.state === 'disabled' ? COPY.notReleased : undefined))
            }
            checked={on}
            disabled={!canManage || busy || revoked || (!on && blocker !== null)}
            onCheckedChange={(next) =>
              void run(() => actions.act(orgId, e, next ? 'enable' : 'disable'))
            }
          />
          <ul aria-label="Before it can turn on" className="flex flex-col gap-1 text-sm">
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
        {canManage ? null : <p className="text-sm text-fg-muted">{COPY.readOnly}</p>}
      </CardBody>
    </Card>
  );
}
