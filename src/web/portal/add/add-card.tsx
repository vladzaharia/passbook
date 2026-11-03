import { useId, useState } from 'react';
import { ADD_COPY } from '../../../shared/copy/add.ts';
import { AddedLine, RevealButton } from './added.tsx';
import type { AddAreaProps } from './area.ts';
import { Viewfinder } from './viewfinder.tsx';
import { AddWays } from './ways.tsx';
import './add-a.css';

const SURFACE =
  'rounded-lg border border-border bg-surface-raised shadow-[var(--wl-edge),var(--pk-elevation-1)]';

/** The QR in its viewfinder well, the ways to add beside it. */
function Scan(p: AddAreaProps) {
  return (
    <div className="wl-a-scan">
      <div className="wl-a-well">
        {p.publicUrl ? <Viewfinder value={p.publicUrl} label={p.qrLabel} /> : null}
      </div>
      <AddWays {...p} />
    </div>
  );
}

/** The iPhone: the badge alone in the well, its clear space around it. */
function Here(p: AddAreaProps) {
  return (
    <div className="wl-a-here">
      <div className="wl-a-well wl-a-badge">{p.badge}</div>
      {p.line ? <p className="px-1 text-sm text-fg-muted">{p.line}</p> : null}
    </div>
  );
}

/**
 * a: one card that only adds. Off the phone, the QR in a viewfinder beside the ways to add; on the
 * iPhone, the badge. In Apple Wallet already, a quiet line, and Show QR opens the card again.
 */
export function AddCard(p: AddAreaProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const scan = p.publicUrl !== null && p.device.device !== 'iphone';
  const body = scan ? <Scan {...p} /> : <Here {...p} />;
  if (p.mode !== 'added') {
    return (
      <section aria-label={ADD_COPY.title} className={`wl-a ${SURFACE}`} data-mode={p.mode}>
        {body}
      </section>
    );
  }
  return (
    <section aria-label={ADD_COPY.added} className={`wl-a ${SURFACE}`} data-mode="added">
      <div className="p-4">
        <AddedLine>
          <RevealButton
            open={open}
            onToggle={() => setOpen((o) => !o)}
            phone={!scan}
            controls={id}
          />
        </AddedLine>
      </div>
      <div id={id} hidden={!open} className="border-t border-border">
        {open ? body : null}
      </div>
    </section>
  );
}
