import { useState } from 'react';
import { maxStamps, minimumMaximum } from '@/passkit/stamps/rules.ts';
import {
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  ErrorState,
  Skeleton,
} from '../../../ui/index.ts';
import { useStampsImpact } from './api.ts';

const cards = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;

export interface GoalChoice {
  keepReady: boolean;
  /** The stamps input's maximum: a full card plus carry-over, never under a live count. */
  maximum: number;
}

/** Saving a new goal on a template with live passes: who is alerted, who falls short. */
export function GoalChangeDialog({
  templateId,
  from,
  to,
  open,
  saving,
  onCancel,
  onConfirm,
}: {
  templateId: string;
  from: number;
  to: number;
  open: boolean;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (choice: GoalChoice) => void;
}) {
  const impact = useStampsImpact(templateId, to, open);
  const [keep, setKeep] = useState(true);
  const data = impact.data;
  const raising = to > from;
  const keepReady = raising && keep;
  const maximum = data ? minimumMaximum(to, keepReady ? data.highestKept : data.highest) : 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        size="sm"
        title={`Change the goal to ${to}?`}
        footer={
          <>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={!data}
              onClick={() => onConfirm({ keepReady, maximum })}
            >
              Save version
            </Button>
          </>
        }
      >
        {impact.isError ? (
          <ErrorState inline error={impact.error} onRetry={() => void impact.refetch()} />
        ) : !data ? (
          <div className="grid gap-2" role="status" aria-label="Checking passes">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <div className="grid gap-3 text-sm text-fg-muted">
            <p>
              {cards(data.passes)} {data.passes === 1 ? 'is' : 'are'} live, {cards(data.readyNow)}{' '}
              ready.
            </p>
            {raising ? (
              data.readyNow > 0 ? (
                <>
                  <CheckboxField
                    label="Keep their rewards ready"
                    checked={keep}
                    onCheckedChange={(v) => setKeep(v === true)}
                  />
                  <p>
                    {keep
                      ? `${cards(data.readyNow)} stay ready: each gets ${to - from} more stamps. Nobody is alerted.`
                      : `${cards(data.readyLost)} drop to "${to - 1} of ${to}" or less. Nobody is alerted.`}
                  </p>
                </>
              ) : (
                <p>No card is ready. Nobody is alerted.</p>
              )
            ) : data.newlyReady > 0 ? (
              <p>
                {cards(data.newlyReady)} become ready. Their holders get a Reward ready alert, once.
              </p>
            ) : (
              <p>No card becomes ready. Nobody is alerted.</p>
            )}
            {maximum > maxStamps(to) ? (
              <p>The stamps maximum is raised to {maximum} so no live card is refused.</p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
