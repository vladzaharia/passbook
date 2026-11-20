import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { LookupPanel, type LookupPanelProps } from './lookup-panel.tsx';
import { LookupTray } from './lookup-tray.tsx';

/** Enter code: a tray with a keypad on a phone, the side panel from 640 up. */
export function LookupSheet({ onClose, ...props }: LookupPanelProps & { onClose: () => void }) {
  const phone = useMediaQuery(PHONE);
  if (phone) return <LookupTray {...props} onClose={onClose} />;
  return (
    <Sheet open={props.open} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="left"
        title="Look up"
        className="scan-lookup-sheet"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (document.querySelector('[data-lookup-editing="true"]')) event.preventDefault();
        }}
      >
        <LookupPanel {...props} />
      </SheetContent>
    </Sheet>
  );
}
