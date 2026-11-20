import type { ReactNode } from 'react';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { type Inside, InsidePanel } from './inside-panel.tsx';
import type { InsideRow } from './inside-types.ts';

/** Who's in as a side sheet: the desk scanner's. Roll call extends it through the panel's slots. */
export function InsideSheet({
  open,
  onClose,
  inside,
  online,
  onOpenRow,
  trailing,
  header,
  footer,
  body,
}: {
  open: boolean;
  onClose: () => void;
  inside: Inside;
  online: boolean;
  onOpenRow: (row: InsideRow) => void;
  trailing?: (row: InsideRow) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /** Replaces the list: the roll call takes the whole sheet while one is open. */
  body?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        title={ACCESS_COPY.inside.title}
        className="scan-inside-sheet"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {body ?? (
          <InsidePanel
            active={open}
            inside={inside}
            online={online}
            onOpenRow={onOpenRow}
            trailing={trailing}
            header={header}
            footer={footer}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
