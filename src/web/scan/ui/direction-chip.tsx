import { ArrowLeftRight, ChevronDown, LogIn, LogOut } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import type { Direction } from '../machine/direction-pin.ts';
import { fill } from './copy.ts';
import { ACCESS_COPY } from './copy-access.ts';
import './scan-access.css';

export type DirectionSetting = 'in' | 'out' | 'both';

const ICON = { in: LogIn, out: LogOut, auto: ArrowLeftRight } as const;

/**
 * The capsule's direction chip. A fixed In or Out has no chevron; a Both scanner shows Auto, or the
 * pinned direction in the accent colour, and opens the sheet.
 */
export function DirectionChip({
  setting,
  pin,
  onOpen,
}: {
  setting: DirectionSetting;
  pin: Direction | null;
  onOpen: () => void;
}) {
  if (setting !== 'both') {
    const Glyph = ICON[setting];
    return (
      <span className="scan-chip" data-slot="direction" data-testid="scan-direction">
        <Glyph aria-hidden size={14} />
        {SCAN_COPY.direction[setting]}
      </span>
    );
  }
  const key = pin ?? 'auto';
  const Glyph = ICON[key];
  const label = key === 'auto' ? SCAN_COPY.direction.auto : SCAN_COPY.direction[key];
  return (
    <button
      type="button"
      className="scan-chip"
      data-slot="direction"
      data-testid="scan-direction"
      data-tone={pin ? 'accent' : undefined}
      aria-label={fill(ACCESS_COPY.direction.chip, { label })}
      onClick={onOpen}
    >
      <Glyph aria-hidden size={14} />
      <span key={key} className="scan-dir-label">
        {label}
      </span>
      <ChevronDown aria-hidden size={14} />
    </button>
  );
}
