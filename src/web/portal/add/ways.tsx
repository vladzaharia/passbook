import { Laptop, Smartphone } from 'lucide-react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import { type AddAreaProps, macBeside } from './area.ts';

/**
 * Beside the QR, the ways to add: scan with the iPhone; on a Mac, the badge. Elsewhere Apple's
 * line says where to go (add.css styles the list).
 */
export function AddWays(p: AddAreaProps) {
  return (
    <div className="wl-ways">
      <div className="wl-way">
        <p className="wl-way-label">
          <Smartphone aria-hidden />
          {HOLDER_COPY.iphone}
        </p>
        <p className="text-sm text-fg-muted">{HOLDER_COPY.scanLine}</p>
      </div>
      {macBeside(p) ? (
        <div className="wl-way wl-mac-only">
          <p className="wl-way-label">
            <Laptop aria-hidden />
            {HOLDER_COPY.mac}
          </p>
          {p.badge}
        </div>
      ) : null}
      {p.line ? <p className="text-sm text-fg-muted">{p.line}</p> : null}
    </div>
  );
}
