import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { Button, Dialog, DialogContent, FormField, Select } from '@/web/ui/index.ts';
import { useRotateKey } from './detail-queries.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import type { ApiKey } from './queries.ts';

const HOUR = 3_600_000;
const OVERLAPS = [
  { value: '0', label: 'Not at all' },
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
];

/** When the old key stops: the chosen overlap, never past its own expiry. */
export const stopsAt = (key: ApiKey, hours: number, now: number) =>
  Math.min(now + hours * HOUR, key.expiresAt ?? Number.POSITIVE_INFINITY);

export function RotateDialog({
  open,
  onOpenChange,
  principal,
  orgName,
  keyData,
  childCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  principal: string;
  orgName: string;
  keyData: ApiKey;
  /** Open child keys: they stop when the old key does. */
  childCount: number;
}) {
  const rotate = useRotateKey(principal);
  const [hours, setHours] = useState('24');
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<{ key: ApiKey & { secret: string }; stopsAt: number }>();

  function close() {
    onOpenChange(false);
    setHours('24');
    setError(undefined);
    setMade(undefined);
  }

  async function submit() {
    setError(undefined);
    try {
      const result = await rotate.mutateAsync({ key: keyData, overlapHours: Number(hours) });
      setMade({ key: result.key, stopsAt: result.previous.retireAt ?? Date.now() });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  if (made) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={
            <span className="inline-flex items-center gap-2">
              <RefreshCw aria-hidden className="size-4 text-accent-fg" />
              Copy the new key
            </span>
          }
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <p className="mb-4 text-sm text-fg">
            {made.stopsAt <= Date.now()
              ? 'The old key has stopped.'
              : `The old key stops ${formatDateTime(made.stopsAt)}.`}
          </p>
          <KeyDisclosure created={made.key} organization={orgName} onDone={close} />
        </DialogContent>
      </Dialog>
    );
  }
  const at = stopsAt(keyData, Number(hours), Date.now());
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        size="sm"
        title="Rotate key"
        description="Makes a new key with the same access. The new key works at once."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={rotate.isPending} onClick={submit}>
              Rotate
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FormField label="Keep the old key working for">
            {(p) => <Select {...p} value={hours} onValueChange={setHours} options={OVERLAPS} />}
          </FormField>
          <p className="text-sm text-fg-muted">
            {Number(hours) === 0
              ? 'Update every consumer first: the old key stops now.'
              : `The old key stops ${formatDateTime(at)}.${childCount > 0 ? ` Its ${childCount} child ${childCount === 1 ? 'key stops' : 'keys stop'} with it.` : ''}`}
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
