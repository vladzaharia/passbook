import { ShieldCheck } from 'lucide-react';
import { SCAN_COPY, scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Dialog, DialogContent } from '../../../ui/dialog.tsx';
import type { PinNote } from '../../machine/types.ts';
import { ApprovalSheet } from '../../result/approval-sheet.tsx';

const R = OPERATOR_COPY.record.pin;

export interface PinDesk {
  managers: { id: string; name: string }[];
  code: boolean;
  approvals: 'managers' | 'desk';
  note: PinNote | undefined;
  onApprove: (staffId: string | undefined, pin: string) => void;
}

/**
 * A Manager's PIN, in place over the record: who is asking, what was held, and that it approves
 * this entry only. The PIN form itself is the scanner's, so the tries and lockout read the same.
 */
export function PinDialog({
  open,
  onOpenChange,
  desk,
  name,
  held,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  desk: PinDesk;
  name: string;
  held: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={SCAN_COPY.actions.managerPin}
        description={scanLine(R.question, { name })}
        data-testid="op-pin"
      >
        {held ? (
          <p className="op-pin-held">
            <ShieldCheck aria-hidden /> {held}
          </p>
        ) : null}
        <ApprovalSheet
          managers={desk.managers}
          code={desk.code}
          desk={desk.approvals === 'desk'}
          note={desk.note}
          onApprove={desk.onApprove}
          onCancel={() => onOpenChange(false)}
        />
        <p className="op-pin-foot">{R.approves}</p>
      </DialogContent>
    </Dialog>
  );
}
