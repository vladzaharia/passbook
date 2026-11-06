import { useQuery } from '@tanstack/react-query';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { ScanInput } from '../input/types.ts';
import { scanId } from '../platform/id.ts';
import { PassSheet } from './pass-sheet.tsx';

export type PassInspection = { card: ScanCard } | { input: ScanInput };
export function PassInspector({
  inspection,
  api,
  onClose,
  orgId,
  timeZone,
}: {
  inspection: PassInspection;
  api: ScanApi;
  onClose: () => void;
  orgId?: string;
  timeZone?: string;
}) {
  const query = useQuery({
    queryKey: [
      'scan',
      'pass',
      'input' in inspection ? inspection.input.id : inspection.card.passId,
    ],
    queryFn: ({ signal }) => {
      if (!('input' in inspection)) throw new Error('No pass selected.');
      const input = inspection.input.passId
        ? { passId: inspection.input.passId, method: 'manual' as const }
        : { code: inspection.input.code ?? '', method: 'manual' as const };
      return api.resolve({ idempotencyKey: scanId(), clientTs: Date.now(), input }, { signal });
    },
    enabled: 'input' in inspection,
    staleTime: 0,
    gcTime: 0,
  });
  const card = 'card' in inspection ? inspection.card : query.data?.card;
  if (card) return <PassSheet card={card} orgId={orgId} timeZone={timeZone} onClose={onClose} />;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent title="Pass" className="scan-detail-sheet">
        <div className="p-5">
          <p role="status">
            {query.isPending ? 'Loading pass…' : 'This pass is no longer available.'}
          </p>
          {query.isError ? (
            <Button variant="secondary" onClick={() => query.refetch()}>
              Retry
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
