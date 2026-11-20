import { Delete } from 'lucide-react';
import type { ReactNode } from 'react';
import { SCAN_TRAY_COPY } from '../../../shared/copy/scan-tray.ts';
import './tray.css';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * The one keypad (codes, PINs): 3 x 4 keys of 60 px, a slot at the bottom left for a mode key, 0
 * and delete. Keys are buttons labelled by their digit; nothing here keeps the digits.
 */
export function Keypad({
  onDigit,
  onDelete,
  disabled,
  corner,
}: {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  disabled?: boolean;
  /** The bottom-left key (ABC); blank when absent. */
  corner?: ReactNode;
}) {
  return (
    <div className="scan-keypad" data-testid="scan-keypad">
      {DIGITS.map((digit) => (
        <button
          key={digit}
          type="button"
          className="scan-key"
          disabled={disabled}
          onClick={() => onDigit(digit)}
        >
          {digit}
        </button>
      ))}
      {corner ?? <span aria-hidden />}
      <button type="button" className="scan-key" disabled={disabled} onClick={() => onDigit('0')}>
        0
      </button>
      <button
        type="button"
        className="scan-key"
        data-kind="delete"
        aria-label={SCAN_TRAY_COPY.delete}
        disabled={disabled}
        onClick={onDelete}
      >
        <Delete aria-hidden size={28} />
      </button>
    </div>
  );
}
