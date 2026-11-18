import { useState } from 'react';
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
import { type ReplayInput, useEndpointActions } from './api.ts';
import { queuedLine, replayError } from './replay-errors.ts';

const HOUR = 3_600_000;
const RANGES = [
  { value: '1', label: 'Last hour', ms: HOUR },
  { value: '24', label: 'Last 24 hours', ms: 24 * HOUR },
  { value: '72', label: 'Last 3 days', ms: 72 * HOUR },
  { value: '168', label: 'Last 7 days', ms: 168 * HOUR },
] as const;
const INCLUDE = [
  { value: 'failed', label: 'Failed' },
  { value: 'failed_and_cancelled', label: 'Failed and cancelled' },
  { value: 'all', label: 'All, delivered too' },
] as const;

/** Replay in bulk: the API takes one range per org and mode a minute, at most 10,000 deliveries. */
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

  const change = (o: boolean) => {
    if (replayRange.isPending) return;
    if (!o) setError(undefined);
    onOpenChange(o);
  };

  async function submit() {
    const ms = RANGES.find((r) => r.value === range)?.ms ?? 24 * HOUR;
    const to = Date.now();
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
        description="Sent again with the same event id and body."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button loading={replayRange.isPending} onClick={() => void submit()}>
              Replay
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
            label="Include events from before this endpoint"
            checked={missing}
            onCheckedChange={(v) => setMissing(v === true)}
          />
          <p className="text-xs text-fg-muted">
            Up to 10,000 deliveries, once a minute. Events older than 7 days are not added.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
