import * as Dialog from '@radix-ui/react-dialog';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { focusInitial, restoreOpener, useOpener } from '../../ui/overlay.tsx';
import { useSnapDrag } from './sheet-frame.tsx';
import './scan-sheet.css';
import './tray.css';

/** How far the on-screen keyboard covers the page, and the height left above it. */
export function useVisibleViewport(): { inset: number; height: number | null } {
  const [view, setView] = useState<{ inset: number; height: number | null }>({
    inset: 0,
    height: null,
  });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setView({
        inset: Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)),
        height: Math.round(vv.height),
      });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return view;
}

export interface TrayProps {
  /** The accessible name of the dialog. */
  label: string;
  onClose: () => void;
  /** Pixels; the tray never grows past the screen. Absent: as tall as its content. */
  height?: number | undefined;
  children: ReactNode;
  testId?: string;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * A short bottom tray (design 6: Enter code 470, Manager PIN 588) from the dock. A grab handle,
 * swipe down and Esc close it; focus is trapped. There is no scrim: the verdict behind stays
 * lit. Under a system keyboard it rides above the keys.
 */
export function Tray({ label, onClose, height, children, testId, onEscapeKeyDown }: TrayProps) {
  const opener = useOpener(true);
  const swipe = useSnapDrag('half', () => undefined, onClose);
  const view = useVisibleViewport();
  const style = {
    '--tray-bottom': `${view.inset}px`,
    '--tray-room': view.height ? `${view.height}px` : '100dvh',
    ...(height ? { '--tray-h': `${height}px` } : {}),
  } as CSSProperties;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          ref={swipe.ref}
          aria-describedby={undefined}
          className="scan-tray wl-dialog"
          data-fixed={height ? '' : undefined}
          data-testid={testId}
          style={style}
          onOpenAutoFocus={focusInitial}
          onCloseAutoFocus={restoreOpener(opener)}
          onInteractOutside={(event) => event.preventDefault()}
          {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})}
        >
          <Dialog.Title className="scan-sr">{label}</Dialog.Title>
          <div className="scan-sheet-grab" {...swipe.handlers}>
            <span aria-hidden />
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
