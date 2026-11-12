import { Laptop } from 'lucide-react';
import { useId, useState } from 'react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { type RenderBuddy, Scan } from './scan.tsx';
import './add.css';

const SURFACE =
  'rounded-lg border border-border bg-surface-raised shadow-[var(--wl-edge),var(--pk-elevation-1)]';

/**
 * The add block: the buddy holds the job. Off the phone the QR leads and the Apple badge remains
 * beside it on every device. On the iPhone the buddy sits on the badge's card. When Apple has
 * reported a registration, it stands happy over a quiet line; Show QR (on the iPhone, Add to this
 * iPhone) brings adding back without the buddy, which stays where it is.
 */
export function AddBlock(p: AddAreaProps & { buddy: RenderBuddy }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const added = p.mode === 'added';
  const url = p.device.device === 'iphone' ? null : p.publicUrl;
  const ask = url ? (
    <Scan url={url} label={p.qrLabel} buddy={added ? undefined : p.buddy}>
      <div className="wl-way">
        <p className="wl-way-label">
          <Laptop aria-hidden />
          Apple Wallet
        </p>
        {p.badge}
      </div>
      {p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
    </Scan>
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
