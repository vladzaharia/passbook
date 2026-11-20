import { ArrowLeftRight, LogIn, LogOut } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import type { ShownDirection } from '../machine/direction-view.ts';
import { fill } from './copy.ts';
import { ACCESS_COPY } from './copy-access.ts';
import { DockButton } from './dock.tsx';
import './scan-direction.css';

const GLYPH = { in: LogIn, out: LogOut, auto: ArrowLeftRight } as const;

/**
 * The thumb row's direction button on a handheld (design 4, 7): one tap goes Auto, In, Out. Out
 * is filled so a door that is checking people out never looks like one checking them in.
 */
export function DirectionButton({
  value,
  onCycle,
}: {
  value: ShownDirection;
  onCycle: () => void;
}) {
  const Glyph = GLYPH[value];
  const label = SCAN_COPY.direction[value];
  return (
    <DockButton
      variant={value === 'out' ? 'filled' : 'gray'}
      className="scan-dir-btn"
      data-testid="dock-direction"
      data-direction={value}
      aria-label={fill(ACCESS_COPY.direction.chip, { label })}
      onClick={onCycle}
    >
      <Glyph aria-hidden size={20} />
      <span key={value} className="scan-dir-word">
        {label}
      </span>
    </DockButton>
  );
}
