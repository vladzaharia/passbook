import { Link } from '@tanstack/react-router';
import { type ReactNode, type Ref, useState } from 'react';
import type { PassView } from '@/shared/pass-view/index.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { canAddToWallet, showsAddQr } from '../../shared/device.ts';
import { cn } from '../lib/cn.ts';
import { useSession } from '../lib/session.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import { AppleWalletBadge, Button, StatusPill } from '../ui/index.ts';
import { ModePill } from '../ui/layout/mode-pill.tsx';
import { browserDevice } from './device.ts';
import { holderPassName, type MyPass } from './pass-view.ts';
import { isPendingRefresh } from './refresh.ts';
import { RefreshIconButton, useRefresh } from './refresh-button.tsx';
import { PassMoreMenu, publicUrlOf, ShowQrButton } from './wallet-actions.tsx';

/** A reported Apple registration: the badge gives way to this pill. */
export function InWalletPill() {
  return <StatusPill status="in_wallet">{HOLDER_COPY.inWalletPill}</StatusPill>;
}

export interface FrontPassProps {
  pass: MyPass;
  view: PassView;
  /** Voided, removed or expired: no adding, the card dims. */
  ended: boolean;
  /** Deal the card in (the list's first arrival). */
  dealt: boolean;
  buddy?: ReactNode;
  /** The name link, focused after a peek comes forward. */
  nameRef?: Ref<HTMLAnchorElement>;
  /** The pass page this front stands for was removed (master-detail): leave it. */
  onRemoved?: () => void;
  /** /passes/:id beside its page: the card is the page's pass, read as itself, not a link. */
  selected?: boolean;
}

/**
 * The stack's front pass: the card, then one action row. The card is the link into the pass and
 * names it; the row repeats none of it (name, org, fields, Active, the Voided its stamp says),
 * keeping only what the card does not say: Test, In Wallet. The row leads with this device's way
 * (shared/device.ts, as the pass page): the badge where it adds, Show QR on a computer, else View
 * pass; then Refresh and More as icons.
 */
export function FrontPass(props: FrontPassProps) {
  const { pass, view, ended, dealt, buddy, nameRef, onRemoved, selected } = props;
  const { authed } = useSession();
  const refresh = useRefresh(pass.id, pass);
  // The holder's own name is no title on their own page: the pass kind leads instead.
  const name = holderPassName(pass, authed?.user);
  const publicUrl = publicUrlOf(pass.pageUrl ?? pass.downloadUrl);
  const removed = pass.removedAt !== null;
  const off = pass.status === 'voided' || removed;
  const [device] = useState(() => browserDevice().device);
  const [dip, setDip] = useState(0);
  const link = { to: '/passes/$passId', params: { passId: pass.id } } as const;
  const live = !ended && !pass.inWallet;
  const badge =
    live && canAddToWallet(device) && pass.downloadUrl && pass.channels?.apple.on !== false;
  const qr = live && !badge && showsAddQr(device) && publicUrl !== null;
  // The card stamps Voided and Removed itself: only In Wallet needs a pill.
  const status = !ended && pass.inWallet ? <InWalletPill /> : null;
  const card = (
    <PassCardStage
      view={view}
      mint={off ? undefined : `${pass.modifiedAt}:${pass.lastRefreshedAt}`}
      settle={pass.status}
      dip={dip}
      enter={dealt}
      dim={ended}
      removed={removed}
      syncing={isPendingRefresh(pass, Date.now())}
      transitionName={`pass-${pass.id}`}
    />
  );
  return (
    <>
      <div className="relative w-full max-w-[22rem]">
        {buddy}
        {/* The name is read, not shown: the card says it. Its link shows itself when focused. */}
        <h2 className="absolute top-1 left-4 z-10 text-sm font-semibold text-fg-strong">
          <Link
            {...link}
            ref={nameRef}
            className="sr-only rounded-sm focus-visible:not-sr-only focus-visible:inline-block focus-visible:bg-surface-raised focus-visible:px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {name}
          </Link>
        </h2>
        {/* The card is a second way in for the pointer; the name's link is the one in the tab order. */}
        {selected ? (
          card
        ) : (
          <Link {...link} tabIndex={-1} aria-hidden className="flex items-center">
            {card}
          </Link>
        )}
      </div>
      <div className={cn('w-full max-w-[22rem]', dealt && 'wl-tile-chrome')}>
        {/* One row, as tall as the badge with its clear space (52, 56 on touch), badge or not. */}
        <div className="@container flex min-h-13 items-center gap-2 pointer-coarse:min-h-14">
          {badge && pass.downloadUrl ? (
            <AppleWalletBadge href={pass.downloadUrl} onClick={() => setDip((n) => n + 1)} />
          ) : qr && publicUrl ? (
            <ShowQrButton passTitle={name} url={publicUrl} />
          ) : status || selected ? null : (
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
            {off ? null : <RefreshIconButton refresh={refresh} className="@max-[20rem]:hidden" />}
            {pass.readOnly ? null : (
              <PassMoreMenu
                passId={pass.id}
                passTitle={name}
                publicUrl={off ? null : publicUrl}
                inWallet={pass.inWallet}
                showQr={!qr}
                help={!off}
                {...(onRemoved ? { onRemoved } : {})}
                {...(off ? {} : { refresh })}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
