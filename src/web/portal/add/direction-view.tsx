import type { ReactNode } from 'react';
import { type AddDirection, addMode } from '../../../shared/add-direction.ts';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import { addLine, type DeviceInfo } from '../../../shared/device.ts';
import type { PassView } from '../../../shared/pass-view/index.ts';
import { AppleWalletBadge } from '../../ui/apple-wallet-badge.tsx';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';
import { Help, type HolderSupport, Notice, PortalLink } from '../holder-parts.tsx';
import { AddCard } from './add-card.tsx';
import type { AddAreaProps } from './area.ts';
import { BuddyAdd, type RenderBuddy } from './buddy-add.tsx';
import type { PassHeading } from './heading.ts';
import { HolderHeading } from './holder-heading.tsx';
import { PhoneAdd } from './phone-add.tsx';
import './add.css';

/** What an exploration needs beyond the shared view's props. */
export interface Explore {
  direction: AddDirection;
  heading: PassHeading;
  view: PassView;
  /** The portal's breadcrumbs (router links). */
  crumbs?: ReactNode;
  /** Status and the last update under the h1 (the portal's pills). */
  meta?: ReactNode;
  inWallet?: boolean;
  /** c: the app's Buddy (its scene in view, click replay); /p's plays once on load. */
  buddy?: RenderBuddy;
}

interface DirectionViewProps {
  pass: ReactNode;
  toggle?: ReactNode;
  passTitle: string;
  orgName: string;
  state: 'active' | 'voided' | 'expired';
  device: DeviceInfo;
  downloadHref: string;
  publicUrl: string | null;
  support?: HolderSupport | null | undefined;
  actions?: ReactNode;
  details?: ReactNode;
  portalHref?: string | undefined;
  onAdd?: (() => void) | undefined;
  theme?: 'light' | 'dark' | undefined;
  rise?: boolean | undefined;
  explore: Explore;
}

const ssrBuddy: RenderBuddy = (p) => <BuddyArt {...p} playOnLoad />;

/**
 * The pass page as one composition (add.css): the header, the pass (sticky at the left from
 * 1024), then the notice and the add block, the portal's details and the org's help. The header
 * carries Refresh and More, so the add block only adds.
 */
export function DirectionView(props: DirectionViewProps) {
  const { explore: x, state, device, publicUrl, support } = props;
  const mode = addMode(state, device, x.inWallet ?? false, publicUrl);
  const buddy = x.buddy ?? ssrBuddy;
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
            <AppleWalletBadge
              href={props.downloadHref}
              onClick={props.onAdd}
              theme={props.theme}
              className="p-0"
            />
          ),
          // Off Apple's devices the QR is the way and the badge stays away, so its line does too.
          line: mode === 'scan' && device.device === 'other' ? null : addLine(device),
          view: x.view,
        };
  const add = !area ? null : x.direction === 'a' ? (
    <AddCard {...area} />
  ) : x.direction === 'b' ? (
    <PhoneAdd {...area} />
  ) : (
    <BuddyAdd {...area} buddy={buddy} />
  );
  const notice = <Notice state={state} orgName={props.orgName} support={support} />;
  const actions =
    props.actions || props.portalHref ? (
      <>
        {props.actions}
        {props.portalHref ? <PortalLink href={props.portalHref} /> : null}
      </>
    ) : null;
  const help = state !== 'voided' && (support?.email || support?.url) ? support : null;
  // b seats the header beside the pass; the breadcrumbs stay above both columns.
  const beside = x.direction === 'b';
  return (
    <div className="wl-dir wl-holder" data-dir={x.direction} data-rise={props.rise || undefined}>
      {beside && x.crumbs ? <div className="wl-dir-crumbs">{x.crumbs}</div> : null}
      <div className="wl-dir-head">
        <HolderHeading
          variant={x.direction === 'a' ? 'title' : 'org'}
          heading={x.heading}
          icon={x.view.images.icon}
          crumbs={beside ? null : x.crumbs}
          meta={x.meta}
          actions={actions}
        />
      </div>
      <div className="wl-dir-pass">
        <div className="relative isolate w-full max-w-[22rem]">{props.pass}</div>
        {props.toggle}
      </div>
      <div className="wl-dir-add">
        {x.direction === 'c' && state === 'voided' ? (
          <div className="wl-c-seat">
            {buddy({
              size: 'sm',
              mood: 'sad',
              scene: 'tear',
              at: 'end',
              className: 'wl-c-buddy-sm',
            })}
            {notice}
          </div>
        ) : (
          notice
        )}
        {add}
      </div>
      {props.details ? <div className="wl-dir-details">{props.details}</div> : null}
      {help ? (
        <div className="wl-dir-help border-t border-border pt-4">
          <Help support={help} />
        </div>
      ) : null}
    </div>
  );
}
