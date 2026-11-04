import { type ReactNode, useId, useState } from 'react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import type { BuddyProps } from '../../ui/art/buddy-art.tsx';
import { QrTile } from '../holder-qr.tsx';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { AddWays } from './ways.tsx';
import './add.css';

/** The buddy as the page draws it: the app's (its scene in view, click replay) or /p's (on load). */
export type RenderBuddy = (props: BuddyProps) => ReactNode;

const SURFACE =
  'rounded-lg border border-border bg-surface-raised shadow-[var(--wl-edge),var(--pk-elevation-1)]';

/**
 * The add block: the buddy holds the job, and the block only adds. Off the phone the buddy sits on
 * the QR's sign (M), leans over and points its teal pass at the code, the ways to add beside it.
 * On the iPhone it sits on the badge's card (S) and points at the badge; the card leads the page
 * there (holder-pass.css), so the badge is on the first screen. In Apple Wallet already, it stands
 * happy over a quiet line; Show QR (on the iPhone, Add to this iPhone) brings adding back without
 * the buddy, which stays where it is.
 */
export function AddBlock(p: AddAreaProps & { buddy: RenderBuddy }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const added = p.mode === 'added';
  const scan = p.publicUrl !== null && p.device.device !== 'iphone';
  const ask = scan ? (
    <div className="wl-add-scan">
      <div className="wl-sign">
        {added
          ? null
          : p.buddy({ size: 'lg', scene: 'nudge', at: 'end', className: 'wl-add-buddy' })}
        {p.publicUrl ? (
          <QrTile value={p.publicUrl} label={p.qrLabel} className="wl-sign-qr" />
        ) : null}
      </div>
      <AddWays {...p} />
    </div>
  ) : (
    <div className={`wl-add-here ${SURFACE}`}>
      {added
        ? null
        : p.buddy({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-add-buddy-sm' })}
      {p.badge}
      {p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
    </div>
  );
  if (!added) {
    return (
      <section aria-label={HOLDER_COPY.addTitle} className="wl-add">
        {ask}
      </section>
    );
  }
  return (
    <section aria-label={HOLDER_COPY.added} className="wl-add">
      <div className={`wl-added ${SURFACE}`}>
        {p.buddy({
          size: 'sm',
          mood: 'happy',
          scene: 'count',
          at: 'start',
          className: 'wl-add-buddy-sm',
        })}
        <AddedLine>
          <RevealButton
            open={open}
            onToggle={() => setOpen((o) => !o)}
            phone={!scan}
            controls={id}
          />
        </AddedLine>
      </div>
      <div id={id} hidden={!open} className="wl-add-again">
        {open ? ask : null}
      </div>
    </section>
  );
}
