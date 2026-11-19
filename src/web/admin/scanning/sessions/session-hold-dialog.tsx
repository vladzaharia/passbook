import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { whenIn } from '@/shared/session-window.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Callout, Dialog, DialogContent, FormField, Select } from '@/web/ui/index.ts';
import { useHoldSession } from './api.ts';

const HOUR = 3_600_000;
/** The server allows at most 24 h ahead; the last choice stays a minute inside it. */
export const OPEN_CHOICES = [
  { value: '1', label: '1 hour', ms: HOUR },
  { value: '2', label: '2 hours', ms: 2 * HOUR },
  { value: '4', label: '4 hours', ms: 4 * HOUR },
  { value: '8', label: '8 hours', ms: 8 * HOUR },
  { value: '24', label: '24 hours', ms: 24 * HOUR - 60_000 },
] as const;

/** Open now: an explicit end, so a forgotten hold cannot stay open. Hours resume at the end. */
export function OpenNowDialog({
  session,
  onClose,
}: {
  session: ScanningSession;
  onClose: () => void;
}) {
  const hold = useHoldSession(session.id);
  const [choice, setChoice] = useState('2');
  const [error, setError] = useState('');
  const [now] = useState(() => Date.now());
  const ms = OPEN_CHOICES.find((c) => c.value === choice)?.ms ?? 2 * HOUR;
  const until = now + ms;
  async function submit() {
    setError('');
    try {
      await hold.mutateAsync({ action: 'open', until, revision: session.updatedAt });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Open now"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={hold.isPending} onClick={() => void submit()}>
              Open now
            </Button>
          </>
        }
      >
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <FormField
          label="Stay open for"
          help={`Open until ${whenIn(until, session.timeZone, now)}. Then the hours resume.`}
        >
          {(p) => (
            <Select
              {...p}
              value={choice}
              options={OPEN_CHOICES.map(({ value, label }) => ({ value, label }))}
              onValueChange={setChoice}
            />
          )}
        </FormField>
      </DialogContent>
    </Dialog>
  );
}
