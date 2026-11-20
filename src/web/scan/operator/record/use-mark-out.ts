import { useCallback, useState } from 'react';
import { ApiError } from '../../../lib/errors.ts';
import { toast } from '../../../ui/toaster.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { scanId } from '../../platform/id.ts';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';

/** Mark out from the record: the exit the Who's in list makes, with the same toast and undo. */
export function useMarkOut(
  api: ScanApi,
  passId: string,
  name: string,
  onChange: (out: boolean) => void,
) {
  const [busy, setBusy] = useState(false);
  const markOut = useCallback(
    async (place: string) => {
      setBusy(true);
      try {
        const done = await api.markOut({ idempotencyKey: scanId(), passId, place });
        const exit = done.scanId;
        if (exit)
          toast.undo(fill(ACCESS_COPY.inside.markedOut, { name }), async () => {
            await api.undo(exit, { idempotencyKey: scanId() });
            onChange(false);
          });
        onChange(true);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_INSIDE') {
          toast.info(fill(ACCESS_COPY.inside.alreadyOut, { name }));
          onChange(true);
        } else toast.error(error, 'Could not mark as out');
      } finally {
        setBusy(false);
      }
    },
    [api, passId, name, onChange],
  );
  return { markOut, busy };
}
