import { ScanQrCode } from 'lucide-react';
import { HardwareIcon } from './icons.tsx';
import { type PillIcon, pillLabel } from './pill-model.ts';
import './hardware.css';

/**
 * The hardware pill: one glyph per detected kind, its state in tint and a badge, no words. A state
 * change pops the glyph; a wedge read blinks the scanner's.
 */
export function HardwarePill({
  icons,
  reads = 0,
  onOpen,
}: {
  icons: readonly PillIcon[];
  /** Bumps per wedge read. */
  reads?: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="hw-pill"
      aria-label={pillLabel(icons)}
      aria-haspopup="dialog"
      data-testid="hardware-pill"
      data-empty={icons.length ? undefined : ''}
      onClick={onOpen}
    >
      {icons.length ? (
        icons.map((icon) => (
          <span
            key={`${icon.kind}:${icon.state}:${icon.kind === 'wedge' ? reads : 0}`}
            className="hw-glyph"
            data-kind={icon.kind}
            data-state={icon.state}
            data-blink={icon.kind === 'wedge' && reads > 0 ? '' : undefined}
          >
            <HardwareIcon kind={icon.kind} state={icon.state} />
          </span>
        ))
      ) : (
        <span className="hw-glyph" data-state="off">
          <ScanQrCode aria-hidden size={16} />
        </span>
      )}
    </button>
  );
}
