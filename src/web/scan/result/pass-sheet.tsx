import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { PassPreview } from './pass-preview.tsx';

export function PassSheet({
  card,
  onClose,
  orgId,
  timeZone,
}: {
  card: ScanCard;
  onClose: () => void;
  orgId?: string;
  timeZone?: string;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent title="Pass" className="scan-detail-sheet">
        <div className="p-4">
          <PassPreview card={card} orgId={orgId} timeZone={timeZone} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
