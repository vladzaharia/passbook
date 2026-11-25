import { Flashlight, Hash, Nfc, Search, Users } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { SCAN_TRAY_COPY } from '../../../shared/copy/scan-tray.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { CountUp } from '../../ui/count-up.tsx';
import { TAG_EXTRA_COPY } from '../assign/copy.ts';
import { ACCESS_COPY } from './copy-access.ts';

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
  /** `square` is 56 x 56 on a handheld (torch, keyboard); `fixed` is 116 wide (Done). */
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

/** The door's thumb row: unified lookup and torch. The camera switch is in the menu. */
export function DoorThumbRow({
  onLookUp,
  onTorch,
  torchOn,
  canTorch = true,
  inside,
  tapToRead,
  direction,
}: {
  onLookUp: () => void;
  /** A Both scanner on a handheld: the direction button (one tap goes Auto, In, Out). */
  direction?: ReactNode;
  /** iPhone and iPad: the system reader opens per tap. */
  tapToRead?: () => void;
  onTorch?: () => void;
  torchOn?: boolean;
  canTorch?: boolean;
  /** Desk scanners with a tracked place: Who's in {42}. */
  inside?: { count: number; onOpen: () => void };
}) {
  const phone = useMediaQuery(PHONE);
  return (
    <>
      {tapToRead ? (
        <DockButton primary variant="filled" data-testid="scan-tap-to-read" onClick={tapToRead}>
          <Nfc aria-hidden size={20} />
          {TAG_EXTRA_COPY.tapToRead}
        </DockButton>
      ) : null}
      <DockButton onClick={onLookUp}>
        {phone ? <Hash aria-hidden size={20} /> : <Search aria-hidden size={20} />}
        {phone ? SCAN_TRAY_COPY.enterCode : SCAN_COPY.actions.lookUp}
      </DockButton>
      {inside ? (
        <DockButton data-testid="scan-inside-open" onClick={inside.onOpen}>
          <Users aria-hidden size={20} className="scan-dock-icon-extra" />
          {ACCESS_COPY.inside.open}
          <CountUp value={inside.count} className="scan-dock-count" />
        </DockButton>
      ) : null}
      {direction}
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
    </>
  );
}
