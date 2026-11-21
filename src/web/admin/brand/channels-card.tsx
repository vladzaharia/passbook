import { useState } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import type { Channel } from '@/shared/contracts/channels.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import type { SetupFacts } from '@/shared/org-setup-checks.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Badge, Card, CardHeader } from '@/web/ui/index.ts';
import { OrgProviderCard } from '../wallet-accounts/org-provider-card.tsx';
import { useOrgCredentials, useOrgEnrolments } from '../wallet-accounts/queries.ts';
import { AppleIdentity } from './apple-identity.tsx';
import { AskPassbook, ChannelRow } from './channel-row.tsx';
import type { Draft } from './draft.ts';

/** The order the page lists them in. */
const ORDER: readonly Channel[] = ['apple', 'mobile', 'google', 'samsung', 'paper', 'nfc'];

/** A wallet's account card, once the wallet is released: the existing card, in the current mode. */
function ProviderAccount({
  orgId,
  provider,
  canManage,
}: {
  orgId: string;
  provider: 'google' | 'samsung';
  canManage: boolean;
}) {
  const mode = useMode();
  const enrolments = useOrgEnrolments(orgId);
  const credentials = useOrgCredentials(orgId);
  const enrolment = enrolments.data?.items.find((e) => e.provider === provider && e.mode === mode);
  if (!enrolment) return null;
  const own = credentials.data?.items.find(
    (c) => c.provider === provider && c.scope === 'org' && c.mode === mode && c.revokedAt === null,
  );
  return <OrgProviderCard orgId={orgId} enrolment={enrolment} own={own} canManage={canManage} />;
}

/**
 * The org's six channels, in the view's mode. Each row's switch is a draft: it saves with the
 * rest of the page, after the review shows what it stops.
 */
export function ChannelsCard({
  orgId,
  orgName,
  view,
  draftFacts,
  draft,
  edit,
  canEdit,
  canManageApple,
  accounts,
}: {
  orgId: string;
  orgName: string;
  view: PassSetup;
  draftFacts: SetupFacts;
  draft: Draft;
  edit: (patch: Partial<Draft>) => void;
  canEdit: boolean;
  canManageApple: boolean;
  /** What the member may do with wallet accounts (integrations:read, integrations:manage). */
  accounts: 'none' | 'read' | 'manage';
}) {
  const mode = useMode();
  const [open, setOpen] = useState<ReadonlySet<Channel>>(new Set());
  const toggle = (c: Channel) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(c)) next.add(c);
      return next;
    });
  return (
    <Card
      id="channels"
      className="scroll-mt-24"
      role="region"
      aria-label={PASS_SETUP_COPY.page.cards.channels}
    >
      <CardHeader
        title={PASS_SETUP_COPY.page.cards.channels}
        actions={<Badge>{PASS_SETUP_COPY.page.mode[mode]}</Badge>}
      />
      <ul className="m-0 flex list-none flex-col divide-y divide-border p-4">
        {ORDER.map((c) => {
          const row = draftFacts.channels[c];
          const stop = stoppingLevel(row.levels);
          const released = stop?.level !== 'passbook' && stop?.level !== 'plan';
          return (
            <ChannelRow
              key={c}
              orgId={orgId}
              channel={c}
              row={row}
              templates={view.templates}
              open={open.has(c)}
              onToggle={() => toggle(c)}
              canEdit={canEdit}
              onAllowed={(allowed) =>
                edit({ channels: { ...draft.channels, [c]: allowed ? 'allowed' : 'blocked' } })
              }
              part={
                c === 'apple' ? (
                  <AppleIdentity orgId={orgId} apple={view.apple} canManage={canManageApple} />
                ) : (c === 'google' || c === 'samsung') && released && accounts !== 'none' ? (
                  <ProviderAccount orgId={orgId} provider={c} canManage={accounts === 'manage'} />
                ) : null
              }
              ask={stop?.level === 'plan' ? <AskPassbook channel={c} orgName={orgName} /> : null}
            />
          );
        })}
      </ul>
    </Card>
  );
}
