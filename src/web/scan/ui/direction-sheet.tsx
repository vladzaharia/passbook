import { ArrowLeftRight, Check, LogIn, LogOut } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { Direction } from '../machine/direction-pin.ts';
import { ACCESS_COPY } from './copy-access.ts';
import './scan-access.css';

const ROWS = [
  { key: 'auto', Glyph: ArrowLeftRight },
  { key: 'in', Glyph: LogIn },
  { key: 'out', Glyph: LogOut },
] as const;

/** Three radio rows and the lapse line. Picking one applies at once; Done closes. */
export function DirectionSheet({
  open,
  pin,
  onPick,
  onClose,
}: {
  open: boolean;
  pin: Direction | null;
  onPick: (direction: Direction | null) => void;
  onClose: () => void;
}) {
  const value = pin ?? 'auto';
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent title={ACCESS_COPY.direction.title} className="scan-detail-sheet">
        <div className="scan-dir-sheet">
          <div role="radiogroup" aria-label={ACCESS_COPY.direction.title} className="scan-dir-rows">
            {ROWS.map(({ key, Glyph }) => (
              <label key={key} className="scan-dir-row" data-checked={value === key}>
                <input
                  type="radio"
                  name="scan-direction"
                  value={key}
                  checked={value === key}
                  onChange={() => onPick(key === 'auto' ? null : key)}
                />
                <span aria-hidden className="scan-dir-icon">
                  <Glyph size={22} />
                </span>
                <span className="scan-dir-text">
                  <span className="scan-dir-name">{ACCESS_COPY.direction.options[key].label}</span>
                  <span className="scan-dir-hint">{ACCESS_COPY.direction.options[key].hint}</span>
                </span>
                <span aria-hidden className="scan-dir-check">
                  <Check size={18} strokeWidth={3} />
                </span>
              </label>
            ))}
          </div>
          <p className="scan-dir-lapse">{ACCESS_COPY.direction.lapse}</p>
          <Button onClick={onClose}>{SCAN_COPY.actions.done}</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
