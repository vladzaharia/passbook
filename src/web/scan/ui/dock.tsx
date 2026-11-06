import { Flashlight, Keyboard, Search } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';

/** The dock: the last-scan strip over the thumb row. Its height is reserved from the first frame. */
export function Dock({ strip, children }: { strip: ReactNode; children?: ReactNode }) {
  return (
    <div className="scan-dock" data-testid="scan-dock">
      {strip}
      <div className="scan-dock-row">{children}</div>
    </div>
  );
}

export interface DockButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** `gray` grows; `filled` is the accent. */
  variant?: 'gray' | 'filled';
  /** `square` is 50 x 50 (torch, keyboard); `fixed` is 116 wide (Done). */
  shape?: 'square' | 'fixed';
  /** The primary action; the e2e hook. */
  primary?: boolean;
}

export function DockButton({
  variant = 'gray',
  shape,
  primary,
  className,
  ...props
}: DockButtonProps) {
  return (
    <button
      type="button"
      className={['scan-dock-btn', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-shape={shape === 'square' ? 'square' : undefined}
      data-size={shape === 'fixed' ? 'fixed' : undefined}
      data-testid={primary ? 'dock-primary' : undefined}
      {...props}
    />
  );
}

/** The door's thumb row: Look up (grows), torch, keyboard. The camera switch is in the menu. */
export function DoorThumbRow({
  onLookUp,
  onTorch,
  torchOn,
  onKeyboard,
  canTorch = true,
}: {
  onLookUp: () => void;
  onTorch?: () => void;
  torchOn?: boolean;
  onKeyboard?: () => void;
  canTorch?: boolean;
}) {
  return (
    <>
      <DockButton onClick={onLookUp}>
        <Search aria-hidden size={20} />
        {SCAN_COPY.actions.lookUp}
      </DockButton>
      {canTorch ? (
        <DockButton
          shape="square"
          aria-label="Torch"
          aria-pressed={torchOn ?? false}
          onClick={onTorch}
        >
          <Flashlight aria-hidden size={22} />
        </DockButton>
      ) : null}
      <DockButton shape="square" aria-label="Type a code" onClick={onKeyboard}>
        <Keyboard aria-hidden size={22} />
      </DockButton>
    </>
  );
}
