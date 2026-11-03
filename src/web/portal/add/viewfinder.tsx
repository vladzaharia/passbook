import { useState } from 'react';
import { QrTile } from '../holder-qr.tsx';

/**
 * The add QR in a camera's viewfinder (a): four corner brackets close in on the code, a scan line
 * sweeps it once, the brackets lock (add-a.css, 1.9 s). Pointing at it (a tap, on touch) replays it:
 * a new key restarts the animated layer. SSR plays it once.
 */
export function Viewfinder({ value, label }: { value: string; label: string }) {
  const [run, setRun] = useState(0);
  const replay = () => setRun((n) => n + 1);
  return (
    <span className="wl-vf" onPointerEnter={replay}>
      <QrTile value={value} label={label} className="wl-vf-tile" />
      <span key={run} aria-hidden className="wl-vf-frame">
        <i data-c="tl" />
        <i data-c="tr" />
        <i data-c="bl" />
        <i data-c="br" />
        <span className="wl-vf-sweep" />
      </span>
    </span>
  );
}
