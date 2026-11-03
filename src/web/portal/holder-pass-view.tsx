import { Ban, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, type DeviceInfo, showsAddQr } from '../../shared/device.ts';
import { cn } from '../lib/cn.ts';
import { AppleWalletBadge } from '../ui/apple-wallet-badge.tsx';
import { Callout } from '../ui/callout.tsx';
import { HolderQr } from './holder-qr.tsx';
import './holder-pass.css';

/** The org's support contacts, already checked (public/service.ts supportContacts). */
export interface HolderSupport {
  email: string | null;
  url: string | null;
}

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
  /** Beside the badge: the portal's Refresh and More. */
  actions?: ReactNode;
  /** Under the add block: the portal's Details card, which seats the nudge. */
  details?: ReactNode;
  /** /p: the quiet way to the holder's page in the portal. */
  portalHref?: string;
  /** As the download starts: the card dips towards the badge. */
  onAdd?: () => void;
  /** /p: the stamped page theme picks the badge art. */
  theme?: 'light' | 'dark';
  /** Deal the side column in after the card (a deep link). */
  rise?: boolean;
}

const LINK = 'font-medium text-accent-fg underline-offset-4 hover:underline';

/** Voided or expired, one line; a voided pass names the org's support so it is not a dead end. */
function Notice({
  state,
  orgName,
  support,
}: Pick<HolderPassViewProps, 'state' | 'orgName' | 'support'>) {
  if (state === 'active') return null;
  const voided = state === 'voided';
  const href = support?.email ? `mailto:${support.email}` : support?.url;
  return (
    <div role="status">
      <Callout tone="warning" icon={voided ? Ban : Clock}>
        {voided ? HOLDER_COPY.voided : HOLDER_COPY.expired}
        {voided && href ? (
          <>
            {' '}
            <a href={href} className={LINK}>
              {HOLDER_COPY.contact(orgName)}
            </a>
          </>
        ) : null}
      </Callout>
    </div>
  );
}

/** The org's support contacts while the pass is live (the voided note carries its own). */
function Help({ support }: { support: HolderSupport }) {
  return (
    <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
      {HOLDER_COPY.help}:{' '}
      {support.email ? (
        <a href={`mailto:${support.email}`} className={LINK}>
          {support.email}
        </a>
      ) : null}
      {support.email && support.url ? ' · ' : null}
      {support.url ? (
        <a href={support.url} className={LINK}>
          {support.url}
        </a>
      ) : null}
    </p>
  );
}

/**
 * The holder's pass page, one composition for the portal (/passes/:id) and the public link (/p,
 * rendered to static markup with the same CSS): the card, then the notice, the add QR where this
 * is not the phone, the Apple badge with the portal's actions beside it, the add line, the
 * portal's details and the org's help. The QR leads where the badge cannot add here.
 */
export function HolderPassView(props: HolderPassViewProps) {
  const { state, device, publicUrl, support } = props;
  const active = state === 'active';
  const line = active ? addLine(device) : null;
  const qr = active && publicUrl && showsAddQr(device.device);
  // The line that says how to add sits with the QR when there is one, else under the badge.
  const qrLine = qr && line === HOLDER_COPY.openOnApple ? line : null;
  const badgeLine = line === qrLine ? null : line;
  const help = state !== 'voided' && (support?.email || support?.url) ? support : null;
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
        {qr ? (
          <div className="flex items-center gap-4">
            <HolderQr value={publicUrl} label={HOLDER_COPY.qrAlt(props.passTitle)} />
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <p className="font-medium text-fg-strong">{HOLDER_COPY.scanQr}</p>
              {qrLine ? <p className="text-fg-muted">{qrLine}</p> : null}
              {/* /p cannot tell an iPad from a Mac by its user agent; a touch screen can. */}
              {device.device === 'mac' ? (
                <p className="wl-ipad-line text-fg-muted">{HOLDER_COPY.openOnApple}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {active || props.actions ? (
          <div className="flex flex-col gap-3">
            {/* The actions wrap as a pair under the badge, never one alone. */}
            <div className="flex flex-wrap items-center gap-2">
              {active ? (
                <AppleWalletBadge
                  href={props.downloadHref}
                  onClick={props.onAdd}
                  theme={props.theme}
                />
              ) : null}
              {props.actions ? (
                <div className="flex items-center gap-2">{props.actions}</div>
              ) : null}
            </div>
            {badgeLine ? <p className="text-sm text-fg-muted">{badgeLine}</p> : null}
          </div>
        ) : null}
        {props.details}
        {help || props.portalHref ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            {help ? <Help support={help} /> : null}
            {props.portalHref ? (
              <p className="text-sm">
                {/* Quiet: muted until pointed at. Signed out, the portal asks to sign in first. */}
                <a
                  href={props.portalHref}
                  className="text-fg-muted underline underline-offset-4 hover:text-fg-strong"
                >
                  {HOLDER_COPY.openInPortal}
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
