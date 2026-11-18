import { useMemo } from 'react';
import { Toaster } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { FailInfo } from '../machine/ports.ts';
import { insidePort } from './inside-api.ts';
import { InsideSheet } from './inside-sheet.tsx';
import type { InsideRow } from './inside-types.ts';
import { useInside } from './use-inside.ts';

/**
 * Who's in, mounted once for a Desk scanner that counts a place. The list lives here, so closing the
 * sheet keeps it, and the Undo toast outlives the sheet (the scanner has no other toaster).
 */
export default function InsideHost({
  api,
  open,
  online,
  onClose,
  onOpenRow,
  onFail,
}: {
  api: ScanApi;
  open: boolean;
  online: boolean;
  onClose: () => void;
  onOpenRow: (row: InsideRow) => void;
  onFail: (info: FailInfo) => void;
}) {
  const port = useMemo(() => insidePort(api), [api]);
  const inside = useInside({ api: port, active: open, online, onFail });
  return (
    <>
      <Toaster />
      <InsideSheet
        open={open}
        onClose={onClose}
        inside={inside}
        online={online}
        onOpenRow={onOpenRow}
      />
    </>
  );
}
