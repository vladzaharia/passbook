import type { ReactNode } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, type DeviceInfo, showsAddQr } from '../../shared/device.ts';
import { cn } from '../lib/cn.ts';
import { AppleWalletBadge } from '../ui/apple-wallet-badge.tsx';
import { DirectionView, type Explore } from './add/direction-view.tsx';
import { Help, type HolderSupport, Notice, PortalLink } from './holder-parts.tsx';
import { HolderQr } from './holder-qr.tsx';
import './holder-pass.css';

export type { HolderSupport } from './holder-parts.tsx';

export interface HolderPassViewProps {
  /** The pass stage: the portal's flippable card; /p's script-free one with its own toggle. */
  pass: ReactNode;
  /** Under the card: the portal's Front / Details control. */
  toggle?: ReactNode;
  passTitle: string;
  orgName: string;
  state: 'active' | 'voided' | 'expired';
  device: DeviceInfo;
  downloadHref: string;
  /** The absolute /p URL the add QR encodes; null hides the QR. */
  publicUrl: string | null;
  support?: HolderSupport | null;
  /** With the badge, at its size: the portal's Refresh and More. */
  actions?: ReactNode;
  /** Under the add block: the portal's Details card, which seats the nudge. */
  details?: ReactNode;
  /** /p: the quiet way to the holder's page in the portal, with the badge. */
  portalHref?: string;
  /** As the download starts: the card dips towards the badge. */
  onAdd?: () => void;
  /** /p: the stamped page theme picks the badge art. */
  theme?: 'light' | 'dark';
  /** Deal the side column in after the card (a deep link). */
  rise?: boolean;
  /** An exploration of the header and add block (shared/add-direction.ts); without one, this layout. */
  explore?: Explore | null;
}

/** The add QR shows: a live pass with a public page, wherever this is not the phone. */
export function showsQr(
  state: HolderPassViewProps['state'],
  device: DeviceInfo,
  publicUrl: string | null,
): publicUrl is string {
  return state === 'active' && publicUrl !== null && showsAddQr(device.device);
}

/**
 * The holder's pass page, one composition for the portal (/passes/:id) and the public link (/p,
 * rendered to static markup with the same CSS): the card, then the notice, the add block, the
 * portal's details and the org's help. Where the QR shows (not the phone), the badge and the
 * actions stack beside it, one column the phone's height and the badge's width; on the phone they
 * follow the badge in a row. The add line closes the block.
 */
export function HolderPassView(props: HolderPassViewProps) {
  if (props.explore) return <DirectionView {...props} explore={props.explore} />;
  const { state, device, publicUrl, support } = props;
  const active = state === 'active';
  const qr = showsQr(state, device, publicUrl);
  const line = active ? addLine(device) : null;
  const help = state !== 'voided' && (support?.email || support?.url) ? support : null;
  // The gaps around the badge are its clear space, so its art lines up with the column's edge.
  const badge = active ? (
    <AppleWalletBadge
      href={props.downloadHref}
      onClick={props.onAdd}
      theme={props.theme}
      className="p-0"
    />
  ) : null;
  const actions =
    props.actions || props.portalHref ? (
      <>
        {props.actions}
        {props.portalHref ? <PortalLink href={props.portalHref} /> : null}
      </>
    ) : null;
  return (
    <div className="wl-holder grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-x-12">
      <div className="flex min-w-0 flex-col items-center gap-3">
        <div className="relative isolate w-full max-w-[22rem]">{props.pass}</div>
        {props.toggle}
      </div>
      <div
        className={cn('wl-pass-side flex min-w-0 flex-col gap-6', props.rise && 'wl-after-card')}
      >
        <Notice state={state} orgName={props.orgName} support={support} />
        {badge || actions ? (
          <div className="flex flex-col gap-2">
            {qr ? (
              // The column wraps under the QR only where the two do not fit side by side.
              <div className="flex flex-wrap items-start gap-3 sm:gap-x-4">
                <div className="flex flex-col gap-2">
                  <HolderQr value={publicUrl} label={HOLDER_COPY.qrAlt(props.passTitle)} />
                  {/* The phone's caption: no wider than the phone, its words run on past it. */}
                  <p className="w-0 min-w-full text-sm font-medium whitespace-nowrap text-fg-strong">
                    {HOLDER_COPY.scanQr}
                  </p>
                </div>
                {/* Three badge-high controls (40, 44 on touch) span the phone's 148 px. */}
                <div className="flex w-fit flex-col gap-3.5 pointer-coarse:gap-2">
                  {badge}
                  {actions}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {badge}
                {/* The actions wrap as a pair under the badge, never one alone. */}
                {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
              </div>
            )}
            {line ? <p className="text-sm text-fg-muted">{line}</p> : null}
            {/* /p cannot tell an iPad from a Mac by its user agent; a touch screen can. */}
            {qr && device.device === 'mac' ? (
              <p className="wl-ipad-line text-sm text-fg-muted">{HOLDER_COPY.openOnApple}</p>
            ) : null}
          </div>
        ) : null}
        {props.details}
        {help ? (
          <div className="border-t border-border pt-4">
            <Help support={help} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
