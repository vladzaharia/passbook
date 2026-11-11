import type { ReactNode } from 'react';
import type { WalletOffer } from '../../shared/contracts/me.ts';
import type {
  WalletProvider,
  WalletProviderIssuance,
} from '../../shared/contracts/wallet-providers.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, type DeviceInfo } from '../../shared/device.ts';
import { walletChoices } from '../../shared/wallet-choice.ts';
import { AppleWalletBadge } from '../ui/apple-wallet-badge.tsx';
import { BuddyArt } from '../ui/art/buddy-art.tsx';
import { AddBlock } from './add/add-block.tsx';
import { type AddAreaProps, addMode } from './add/area.ts';
import type { RenderBuddy } from './add/scan.tsx';
import { Help, type HolderSupport, Notice } from './holder-parts.tsx';
import { WalletChoices } from './wallet-choice.tsx';
import './holder-pass.css';

export type { HolderSupport } from './holder-parts.tsx';

export interface HolderPassViewProps {
  /** The pass stage: the portal's flippable card; /p's script-free one with its own toggle. */
  pass: ReactNode;
  /** Under the card: the portal's Front / Details control. */
  toggle?: ReactNode;
  passTitle: string;
  orgName: string;
  state: 'active' | 'voided' | 'expired' | 'removed';
  /** The org's note with a removal (state removed). */
  removalMessage?: string | null;
  device: DeviceInfo;
  downloadHref: string;
  /** Available native alternatives, independent of the Apple registration state. */
  walletOffers: readonly WalletOffer[];
  /** The server's release gate per native wallet; disabled ones are not offered. */
  issuance?: Partial<Record<WalletProvider, WalletProviderIssuance>>;
  /** The absolute /p URL the add QR encodes; null hides the QR. */
  publicUrl: string | null;
  /** Server-rendered presentation, separate from the page-opening QR. */
  barcodeHref?: string | undefined;
  support?: HolderSupport | null;
  /** An Apple device registration was reported (the portal knows; /p does not). */
  inWallet?: boolean;
  /** Under the add block: the portal's Details card. */
  details?: ReactNode;
  /** As the download starts: the card dips towards the badge. */
  onAdd?: () => void;
  /** Deal the side column in after the card (a deep link). */
  rise?: boolean;
  /** The app's Buddy (its scene in view, click replay); /p's plays once on load. */
  buddy?: RenderBuddy;
}

const ssrBuddy: RenderBuddy = (p) => <BuddyArt {...p} playOnLoad />;

/**
 * The holder's pass page under its header, one composition for the portal (/passes/:id) and the
 * public link (/p, rendered to static markup with the same CSS): the card (sticky at the left
 * from 1024), then the notice and the add block, the portal's details and the org's help. The
 * header above carries Refresh and More, so the add block only adds.
 */
export function HolderPassView(props: HolderPassViewProps) {
  const { state, device, publicUrl, support } = props;
  const mode = addMode(state, device, props.inWallet ?? false, publicUrl);
  const buddy = props.buddy ?? ssrBuddy;
  const area: AddAreaProps | null =
    mode === 'off'
      ? null
      : {
          mode,
          device,
          publicUrl,
          qrLabel: HOLDER_COPY.qrAlt(props.passTitle),
          // The gaps around the badge are its clear space.
          badge: (
            <AppleWalletBadge href={props.downloadHref} onClick={props.onAdd} className="p-0" />
          ),
          // Apple's guidance accompanies the badge on every device.
          line: addLine(device),
        };
  const help =
    state !== 'voided' && !support?.platform && (support?.email || support?.url) ? support : null;
  // On the iPhone the badge's card leads, so it is on the first screen; the pass follows it.
  const lead = mode === 'phone' && device.device === 'iphone';
  return (
    <div
      className="wl-holder"
      data-lead={lead ? 'add' : state === 'active' ? undefined : 'notice'}
      data-rise={props.rise || undefined}
    >
      <div className="wl-holder-pass">
        <div className="relative isolate w-full max-w-[22rem]">{props.pass}</div>
        {props.toggle}
      </div>
      <div className="wl-holder-add">
        {state === 'active' ? null : (
          // A pass that cannot be added: the buddy sits on the notice, sad.
          <div className="wl-add-seat">
            {state === 'voided'
              ? buddy({ size: 'sm', mood: 'sad', scene: 'tear', at: 'end' })
              : buddy({ size: 'sm', mood: 'sad', state: 'expired', at: 'end' })}
            <Notice
              state={state}
              orgName={props.orgName}
              support={support}
              message={props.removalMessage}
            />
          </div>
        )}
        {state === 'active' || area ? (
          <WalletChoices
            choices={walletChoices({
              device,
              apple: area !== null,
              browserHref: state === 'active' ? props.barcodeHref : undefined,
              offers: state === 'active' ? props.walletOffers : [],
              ...(props.issuance ? { issuance: props.issuance } : {}),
            })}
            apple={area ? <AddBlock {...area} buddy={buddy} /> : null}
          />
        ) : null}
      </div>
      {props.details ? <div className="wl-holder-details">{props.details}</div> : null}
      {help ? (
        <div className="wl-holder-help border-t border-border pt-4">
          <Help support={help} />
        </div>
      ) : null}
    </div>
  );
}
