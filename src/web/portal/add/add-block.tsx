import { useId, useState } from 'react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import { isAndroid } from '../../../shared/device.ts';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { type RenderBuddy, Scan } from './scan.tsx';
import './add.css';

/**
 * The add block, the page's one lead: a single card the buddy sits on, at its end, clear of the
 * code. Off the phone the QR and one line, the caller's badge (a Mac's, Add all) under it, quietly.
 * On the iPhone the badge alone. When Apple has reported a registration, the happy buddy stands over one line;
 * Show QR (on the iPhone, Add to this iPhone) brings adding back without a second buddy. An
 * Android phone cannot add to Apple Wallet: one text line, listed with the other ways.
 */
export function AddBlock(p: AddAreaProps & { buddy: RenderBuddy }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (isAndroid(p.device.device)) {
    return <p className="wl-add-line">{HOLDER_COPY.appleElsewhere}</p>;
  }
  const added = p.mode === 'added';
  const url = p.device.device === 'iphone' ? null : p.publicUrl;
  const badge = url ? p.badge : null;
  const seat = added ? undefined : p.buddy;
  const ask = url ? (
    <div className="wl-hero wl-hero-scan">
      {seat?.({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-hero-buddy' })}
      <Scan url={url} label={p.qrLabel}>
        {badge ? (
          <div className="wl-way wl-way-here">
            {p.device.device === 'mac' ? <span>{HOLDER_COPY.onThisMac}</span> : null}
            {badge}
          </div>
        ) : null}
        {badge && p.line ? <p className="wl-hero-note">{p.line}</p> : null}
      </Scan>
    </div>
  ) : (
    <div className="wl-hero wl-hero-phone">
      {seat?.({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-hero-buddy' })}
      {p.badge}
      {p.line ? <p className="wl-hero-note">{p.line}</p> : null}
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
      <div className="wl-hero wl-added">
        {p.buddy({
          size: 'sm',
          mood: 'happy',
          scene: 'count',
          at: 'end',
          className: 'wl-hero-buddy',
        })}
        <AddedLine>
          <RevealButton
            open={open}
            onToggle={() => setOpen((o) => !o)}
            phone={url === null}
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
