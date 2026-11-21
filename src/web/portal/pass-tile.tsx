import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { canAddToWallet, showsAddQr } from '../../shared/device.ts';
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
 * Two rows of the list's grid (subgrid): the card, then one action row, so a row of tiles lines
 * them up. The card is the link into the pass and names it; the tile repeats none of it (name,
 * org, fields, Active, the Voided its stamp says), keeping only what the card does not say: Test,
 * In Wallet. The row leads with this device's way (shared/device.ts, as the pass page): the badge
 * where it adds, Show QR on a computer, else View pass; then Refresh and More as icons.
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
  const [device] = useState(() => browserDevice().device);
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  const live = !voided && !pass.inWallet;
  const badge =
    live && canAddToWallet(device) && pass.downloadUrl && pass.channels?.apple.on !== false;
  const qr = live && !badge && showsAddQr(device) && publicUrl !== null;
  // The card stamps Voided and Removed itself: only In Wallet needs a pill.
  const status = !voided && pass.inWallet ? <InWalletPill /> : null;
  return (
    // The tile's corner is the 18 px card radius: the pass inside draws ~14 px, never more.
    <Card className="row-span-2 grid grid-rows-subgrid gap-y-3 rounded-xl p-4">
      {buddy}
      <h2 className="sr-only">{name}</h2>
      <Link
        {...link}
        aria-label={name}
        className="flex items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
      >
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
        {/* One row, as tall as the badge with its clear space (52, 56 on touch), badge or not. */}
        <div className="@container flex min-h-13 items-center gap-2 pointer-coarse:min-h-14">
          {badge && pass.downloadUrl ? (
            <AppleWalletBadge href={pass.downloadUrl} onClick={() => setDip((n) => n + 1)} />
          ) : qr && publicUrl ? (
            <ShowQrButton passTitle={name} url={publicUrl} />
          ) : status ? null : (
            <Button asChild variant="outline">
              <Link {...link}>View pass</Link>
            </Button>
          )}
          {status || pass.mode === 'test' ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <ModePill mode={pass.mode} />
              {status}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {voided ? null : (
              <RefreshIconButton refresh={refresh} className="@max-[20rem]:hidden" />
            )}
            <PassMoreMenu
              passId={pass.id}
              passTitle={name}
              publicUrl={voided ? null : publicUrl}
              inWallet={pass.inWallet}
              showQr={!qr}
              {...(voided ? {} : { refresh })}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
