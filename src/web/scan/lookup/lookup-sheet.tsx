import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { LookupPanel, type LookupPanelProps } from './lookup-panel.tsx';

export function LookupSheet({ onClose, ...props }: LookupPanelProps & { onClose: () => void }) {
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
