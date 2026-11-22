import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';
import { Callout } from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';

/** Who is told, from the server's sample of the 200 newest passes. Said plainly as an estimate. */
export function Estimate({
  preview,
}: {
  preview: z.infer<typeof ChangeRunPreviewSchema> | undefined;
}) {
  if (!preview) return null;
  return (
    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
      <p className="font-medium text-fg-strong">
        {C.holders.estimate(preview.notified, preview.silent)}
      </p>
      {preview.estimated && preview.targeted > 200 ? (
        <p className="text-fg-muted">{C.holders.from200}</p>
      ) : null}
      {preview.overBudget > 0 ? (
        <Callout tone="info">{C.holders.budget(preview.overBudget)}</Callout>
      ) : null}
    </div>
  );
}
