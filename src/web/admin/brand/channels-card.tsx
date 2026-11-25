import { useState } from 'react';
import { stoppedAboveOrg } from '@/shared/channels.ts';
import type { Channel } from '@/shared/contracts/channels.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import type { SetupFacts } from '@/shared/org-setup-checks.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Badge, Card, CardHeader } from '@/web/ui/index.ts';
import { OrgProviderCard } from '../wallet-accounts/org-provider-card.tsx';
import { useOrgCredentials, useOrgEnrolments } from '../wallet-accounts/queries.ts';
import { AccountTiles } from './account-tiles.tsx';
import { AppleIdentity } from './apple-identity.tsx';
import { ChannelRow } from './channel-row.tsx';
import type { Draft } from './draft.ts';

/** The order the page lists them in. */
const ORDER: readonly Channel[] = ['apple', 'mobile', 'google', 'samsung', 'paper', 'nfc'];

/** A wallet's account card, once the wallet is released: the existing card, in the current mode. */
function ProviderAccount({
  orgId,
  provider,
  canManage,
  canReissue,
}: {
  orgId: string;
  provider: 'google' | 'samsung';
  canManage: boolean;
  canReissue: boolean;
}) {
  const mode = useMode();
  const enrolments = useOrgEnrolments(orgId);
  const credentials = useOrgCredentials(orgId);
  const enrolment = enrolments.data?.items.find((e) => e.provider === provider && e.mode === mode);
  if (!enrolment) return null;
  const own = credentials.data?.items.find(
    (c) => c.provider === provider && c.scope === 'org' && c.mode === mode && c.revokedAt === null,
  );
  return (
    <div className="flex flex-col gap-4">
      {provider === 'google' && enrolment.source === null && own === undefined ? (
        <AccountTiles orgId={orgId} canManage={canManage} />
      ) : null}
      <OrgProviderCard
        orgId={orgId}
        enrolment={enrolment}
        own={own}
        canManage={canManage}
        canReissue={canReissue}
      />
    </div>
  );
}

/**
 * The channels the org can use, in the view's mode; the rest are not listed. Each row's switch is
 * a draft: it saves with the rest of the page, after the review shows what it stops.
 */
export function ChannelsCard({
  orgId,
  view,
  draftFacts,
  draft,
  edit,
  canEdit,
  canManageApple,
  accounts,
  canOperatePasses = false,
}: {
  orgId: string;
  view: PassSetup;
  draftFacts: SetupFacts;
  draft: Draft;
  edit: (patch: Partial<Draft>) => void;
  canEdit: boolean;
  canManageApple: boolean;
  /** What the member may do with wallet accounts (integrations:read, integrations:manage). */
  accounts: 'none' | 'read' | 'manage';
  /** passes:operate, which a wallet reissue needs (the API asks for it, not integrations:manage). */
  canOperatePasses?: boolean;
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
        {ORDER.filter((c) => !stoppedAboveOrg(draftFacts.channels[c].levels)).map((c) => {
          const row = draftFacts.channels[c];
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
                ) : (c === 'google' || c === 'samsung') && accounts !== 'none' ? (
                  <ProviderAccount
                    orgId={orgId}
                    provider={c}
                    canManage={accounts === 'manage'}
                    canReissue={canOperatePasses}
                  />
                ) : null
              }
            />
          );
        })}
      </ul>
    </Card>
  );
}
