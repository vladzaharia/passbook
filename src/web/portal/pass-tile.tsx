import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { canAddToWallet } from '../../shared/device.ts';
import { distinguishingLine } from '../../shared/pass-view/index.ts';
import { cn } from '../lib/cn.ts';
import { useSession } from '../lib/session.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import { AppleWalletBadge, Button, Card, StatusPill } from '../ui/index.ts';
import { ModePill } from '../ui/layout/mode-pill.tsx';
import { browserDevice } from './device.ts';
import { holderPassName, type MyPass, toView } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshIconButton, useRefresh } from './refresh-button.tsx';
import { PassMoreMenu, publicUrlOf, ShowQrButton } from './wallet-actions.tsx';

/** A reported Apple registration: the badge gives way to this pill. */
export function InWalletPill() {
  return <StatusPill status="in_wallet">{HOLDER_COPY.inWalletPill}</StatusPill>;
}

/**
 * Three rows of the list's grid (subgrid): the card, then title and org, then the actions, so a
 * row of tiles lines them up however their actions wrap. The actions beside the badge are
 * badge-sized outline buttons.
 */
export function PassTile({
  pass,
  dealt,
  buddy,
}: {
  pass: MyPass;
  dealt: boolean;
  buddy?: ReactNode;
}) {
  const { authed } = useSession();
  const refresh = useRefresh(pass.id, pass);
  // The holder's own name is no title on their own page: the pass kind leads instead.
  const name = holderPassName(pass, authed?.user);
  const publicUrl = publicUrlOf(pass.pageUrl ?? pass.downloadUrl);
  const removed = pass.removedAt !== null;
  const voided = pass.status === 'voided' || removed;
  // Where the badge cannot add, Show QR leads; elsewhere off the phone it waits in More.
  const [qr] = useState(() => !canAddToWallet(browserDevice().device));
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  return (
    // The tile's corner is the 18 px card radius: the pass inside draws ~14 px, never more.
    <Card className="row-span-3 grid grid-rows-subgrid gap-y-3 rounded-xl p-4">
      {buddy}
      {/* The card is a second way into the pass; the title link is the one in the tab order. */}
      <Link {...link} tabIndex={-1} aria-hidden className="mb-1 flex items-center">
        <PassCardStage
          view={toView(pass)}
          mint={voided ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
          settle={pass.status}
          dip={dip}
          enter={dealt}
          dim={voided}
          removed={removed}
          syncing={isPendingRefresh(pass, Date.now())}
          transitionName={`pass-${pass.id}`}
        />
      </Link>
      <div className={cn('contents', dealt && 'wl-tile-chrome')}>
        <div className="min-w-0">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h2 className="min-w-0 text-sm font-semibold text-fg-strong">
              {/* A block link truncates on its own box, so the 44 px touch padding is not clipped. */}
              <Link
                {...link}
                className="block truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:-my-3 pointer-coarse:py-3"
              >
                {name}
              </Link>
            </h2>
            <span className="flex shrink-0 items-center gap-1.5">
              <ModePill mode={pass.mode} />
              {voided ? (
                <StatusPill status={removed ? 'removed' : 'voided'} />
              ) : pass.inWallet ? (
                <InWalletPill />
              ) : (
                <StatusPill status="active" />
              )}
            </span>
          </div>
          <p className="truncate text-xs text-fg-muted">
            {[pass.orgName, distinguishingLine(pass.passJson, name)].filter(Boolean).join(' · ')}
          </p>
        </div>
        {/* As tall as the badge with its clear space (52, 56 on touch), badge or not. */}
        <div className="@container flex min-h-13 flex-wrap content-end items-center justify-between gap-2 pointer-coarse:min-h-14">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link {...link}>View pass</Link>
            </Button>
            {voided || pass.inWallet || !qr || !publicUrl ? null : (
              <ShowQrButton passTitle={name} url={publicUrl} />
            )}
            {voided ||
            pass.inWallet ||
            !pass.downloadUrl ||
            pass.channels?.apple.on === false ? null : (
              <AppleWalletBadge href={pass.downloadUrl} onClick={() => setDip((n) => n + 1)} />
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {voided ? null : (
              <RefreshIconButton refresh={refresh} className="@max-[24rem]:hidden" />
            )}
            <PassMoreMenu
              passId={pass.id}
              passTitle={name}
              publicUrl={voided ? null : publicUrl}
              inWallet={pass.inWallet}
              {...(voided ? {} : { refresh })}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
