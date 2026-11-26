import { useMemo, useState } from 'react';
import {
  Button,
  Callout,
  CheckboxField,
  Dialog,
  DialogContent,
  FormField,
  Select,
  toast,
} from '../../../ui/index.ts';
import { type ReplayInput, useEndpointActions, useReplayPreview } from './api.ts';
import { queuedLine, replayError } from '../../../ui/webhooks/replay-errors.ts';

const HOUR = 3_600_000;
const RANGES = [
  { value: '1', label: 'Last hour', ms: HOUR },
  { value: '24', label: 'Last 24 hours', ms: 24 * HOUR },
  { value: '72', label: 'Last 3 days', ms: 72 * HOUR },
  { value: '168', label: 'Last 7 days', ms: 168 * HOUR },
] as const;
const MINUTE = 60_000;
const INCLUDE = [
  { value: 'failed', label: 'Failed' },
  { value: 'failed_and_cancelled', label: 'Failed and cancelled' },
  { value: 'all', label: 'All, delivered too' },
] as const;

/**
 * Replay in bulk: the API takes one range per org and mode a minute, at most 10,000 deliveries.
 * Every delivery goes to this endpoint's own URL. The count is a dry run of the same request.
 */
export function ReplayDialog({
  endpointId,
  open,
  onOpenChange,
}: {
  endpointId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { replayRange } = useEndpointActions(endpointId);
  const [range, setRange] = useState('24');
  const [include, setInclude] = useState<ReplayInput['include']>('failed');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string>();

  const ms = RANGES.find((r) => r.value === range)?.ms ?? 24 * HOUR;
  // The window's end moves by the minute, so the preview is one query, not one per render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new minute is a new window
  const to = useMemo(() => Math.floor(Date.now() / MINUTE) * MINUTE, [open]);
  const preview = useReplayPreview(
    endpointId,
    { from: to - ms, to, include, ...(missing ? { missing: true } : {}) },
    open,
  );
  const count = preview.data?.queued;

  const change = (o: boolean) => {
    if (replayRange.isPending) return;
    if (!o) setError(undefined);
    onOpenChange(o);
  };

  // Replays the window the preview counted, so "Replay N" is what gets queued.
  async function submit() {
    setError(undefined);
    try {
      const { queued } = await replayRange.mutateAsync({
        from: to - ms,
        to,
        include,
        ...(missing ? { missing: true } : {}),
      });
      if (queued === 0) toast.info('Nothing to replay in that range.');
      else toast.success(queuedLine(queued));
      onOpenChange(false);
    } catch (cause) {
      setError(replayError(cause, true));
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        title="Replay deliveries"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button
              loading={replayRange.isPending}
              disabled={count === 0}
              onClick={() => void submit()}
            >
              {count ? `Replay ${count}` : 'Replay'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <FormField label="Range">
            {(f) => (
              <Select
                {...f}
                value={range}
                onValueChange={setRange}
                options={RANGES.map(({ value, label }) => ({ value, label }))}
              />
            )}
          </FormField>
          <FormField label="Deliveries">
            {(f) => (
              <Select
                {...f}
                value={include ?? 'failed'}
                onValueChange={(v) => setInclude(v as ReplayInput['include'])}
                options={INCLUDE.map(({ value, label }) => ({ value, label }))}
              />
            )}
          </FormField>
          <CheckboxField
            label="Also send events from before this endpoint was added"
            checked={missing}
            onCheckedChange={(v) => setMissing(v === true)}
          />
          <p role="status" className="text-sm font-medium text-fg-strong">
            {preview.isError
              ? 'Could not count. Replay still works.'
              : count === undefined
                ? 'Counting…'
                : count === 0
                  ? 'No deliveries match.'
                  : `${count} ${count === 1 ? 'delivery matches' : 'deliveries match'}.`}
          </p>
          <p className="text-xs text-fg-muted">
            Sends at most 10,000, one batch per minute. Added events reach back 7 days.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
