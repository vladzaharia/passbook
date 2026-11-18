import { ArrowLeftRight, LogIn, LogOut } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { RadioGroup } from '../../ui/radio-group.tsx';
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
          <RadioGroup
            legend={ACCESS_COPY.direction.title}
            value={value}
            onValueChange={(next) => onPick(next === 'auto' ? null : (next as Direction))}
            options={ROWS.map(({ key, Glyph }) => ({
              value: key,
              label: (
                <span className="scan-dir-name">
                  <Glyph aria-hidden size={18} />
                  {ACCESS_COPY.direction.options[key].label}
                </span>
              ),
              hint: ACCESS_COPY.direction.options[key].hint,
            }))}
          />
          <p className="scan-dir-lapse">{ACCESS_COPY.direction.lapse}</p>
          <Button onClick={onClose}>{SCAN_COPY.actions.done}</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
