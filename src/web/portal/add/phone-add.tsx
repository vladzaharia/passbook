import { useId, useState } from 'react';
import { ADD_COPY } from '../../../shared/copy/add.ts';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { Phone } from './phone.tsx';
import { AddWays } from './ways.tsx';
import './add-b.css';

/**
 * On the iPhone there is no phone to draw: the badge rides in a dock at the screen's foot, in
 * reach of the thumb wherever the page scrolls (add-b.css keeps the page's end clear of it).
 */
function Dock(p: AddAreaProps) {
  return (
    <div className="wl-b-dock">
      {p.badge}
      {p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
    </div>
  );
}

/**
 * b: the iPhone shows how. Off the phone, the drawn iPhone frames the add QR, recognises it and
 * raises the Add sheet; the ways to add stand beside it. In Apple Wallet already, the phone shows
 * the pass in its stack and Show QR turns it back to the camera.
 */
export function PhoneAdd(p: AddAreaProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const iphone = p.device.device === 'iphone' || p.publicUrl === null;
  if (p.mode === 'phone') return <Dock {...p} />;
  const added = p.mode === 'added';
  const reveal = added ? (
    <AddedLine>
      <RevealButton open={open} onToggle={() => setOpen((o) => !o)} phone={iphone} controls={id} />
    </AddedLine>
  ) : null;
  if (iphone) {
    return (
      <section aria-label={ADD_COPY.added} className="wl-b wl-b-flat">
        {reveal}
        <div id={id} hidden={!open} className="wl-b-again">
          {open ? p.badge : null}
          {open && p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
        </div>
      </section>
    );
  }
  return (
    <section aria-label={added ? ADD_COPY.added : ADD_COPY.title} className="wl-b">
      <div className="wl-b-stage">
        <Phone
          screen={added && !open ? 'wallet' : 'scan'}
          view={p.view}
          publicUrl={p.publicUrl}
          qrLabel={p.qrLabel}
        />
      </div>
      <div className="wl-b-side">
        {reveal}
        <div id={id} hidden={added && !open} className="wl-b-ways">
          {added && !open ? null : <AddWays {...p} />}
        </div>
      </div>
    </section>
  );
}
