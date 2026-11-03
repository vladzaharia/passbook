import { type ReactNode, useId, useState } from 'react';
import { ADD_COPY } from '../../../shared/copy/add.ts';
import type { BuddyProps } from '../../ui/art/buddy-art.tsx';
import { QrTile } from '../holder-qr.tsx';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { AddWays } from './ways.tsx';
import './add-c.css';

/** The buddy as the page draws it: the app's (scene in view, click replay) or /p's (on load). */
export type RenderBuddy = (props: BuddyProps) => ReactNode;

const SURFACE =
  'rounded-lg border border-border bg-surface-raised shadow-[var(--wl-edge),var(--pk-elevation-1)]';

/**
 * c: the buddy holds the job. Off the phone it sits on the QR's sign (M), leans over and points
 * its teal pass down at the code; the ways to add stand beside. On the iPhone it sits on the
 * badge's card (S) and points at the badge. In Apple Wallet already it sits on the line, happy,
 * and counts its passes; Show QR brings the sign back.
 */
export function BuddyAdd(p: AddAreaProps & { buddy: RenderBuddy }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const scan = p.publicUrl !== null && p.device.device !== 'iphone';
  const ask = scan ? (
    <div className="wl-c-scan">
      <div className="wl-c-sign">
        {p.mode === 'added'
          ? null
          : p.buddy({ size: 'lg', scene: 'nudge', at: 'end', className: 'wl-c-buddy' })}
        {p.publicUrl ? <QrTile value={p.publicUrl} label={p.qrLabel} className="wl-c-qr" /> : null}
      </div>
      <AddWays {...p} />
    </div>
  ) : (
    <div className={`wl-c-here ${SURFACE}`}>
      {p.mode === 'added'
        ? null
        : p.buddy({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-c-buddy-sm' })}
      {p.badge}
      {p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
    </div>
  );
  if (p.mode !== 'added') {
    return (
      <section aria-label={ADD_COPY.title} className="wl-c" data-mode={p.mode}>
        {ask}
      </section>
    );
  }
  return (
    <section aria-label={ADD_COPY.added} className="wl-c" data-mode="added">
      <div className={`wl-c-added ${SURFACE}`}>
        {p.buddy({
          size: 'sm',
          mood: 'happy',
          scene: 'count',
          at: 'end',
          className: 'wl-c-buddy-sm',
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
      <div id={id} hidden={!open} className="wl-c-again">
        {open ? ask : null}
      </div>
    </section>
  );
}
