import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime } from '@/web/lib/format.ts';
import { FormDialog, FormField, Select } from '@/web/ui/index.ts';
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
  const [made, setMade] = useState<{ key: ApiKey & { secret: string }; stopsAt: number }>();

  async function submit() {
    const result = await rotate.mutateAsync({ key: keyData, overlapHours: Number(hours) });
    setMade({ key: result.key, stopsAt: result.previous.retireAt ?? Date.now() });
  }

  const at = stopsAt(keyData, Number(hours), Date.now());
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rotate key"
      description="Same access. The new key works at once."
      dirty={hours !== '24'}
      onSubmit={submit}
      submitLabel="Rotate"
      busy={rotate.isPending}
      onClose={() => {
        setHours('24');
        setMade(undefined);
      }}
      result={
        made
          ? {
              title: 'Copy the new key',
              icon: <RefreshCw />,
              body: (
                <>
                  <p className="text-sm text-fg">
                    {made.stopsAt <= Date.now()
                      ? 'The old key has stopped.'
                      : `The old key stops ${formatDateTime(made.stopsAt)}.`}
                  </p>
                  <KeyDisclosure
                    created={made.key}
                    organization={orgName}
                    onDone={() => onOpenChange(false)}
                  />
                </>
              ),
            }
          : undefined
      }
    >
      <FormField label="Keep the old key working for">
        {(p) => <Select {...p} value={hours} onValueChange={setHours} options={OVERLAPS} />}
      </FormField>
      <p className="text-sm text-fg-muted">
        {Number(hours) === 0
          ? 'Update every consumer first: the old key stops now.'
          : `The old key stops ${formatDateTime(at)}.${childCount > 0 ? ` Its ${childCount} child ${childCount === 1 ? 'key stops' : 'keys stop'} with it.` : ''}`}
      </p>
    </FormDialog>
  );
}
