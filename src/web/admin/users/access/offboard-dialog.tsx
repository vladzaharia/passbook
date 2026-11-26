import { useEffect, useState } from 'react';
import type { OffboardPlan } from '@/shared/contracts/idp-access.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  FormField,
  Input,
  Skeleton,
} from '@/web/ui/index.ts';
import { planLines } from './offboard-plan.ts';

/** The dry-run plan, then the word to type, then the run. Confirming is off while an org would lose its last admin. */
export function OffboardDialog({
  open,
  onOpenChange,
  name,
  plan,
  loading,
  loadError,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  plan: OffboardPlan | undefined;
  loading: boolean;
  loadError: unknown;
  onConfirm: () => Promise<unknown>;
}) {
  const word = name.length <= 24 ? name : 'offboard';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) {
      setTyped('');
      setError(undefined);
    }
  }, [open]);
  const blockers = plan?.blockers ?? [];
  const ready =
    Boolean(plan) && blockers.length === 0 && typed.trim().toLowerCase() === word.toLowerCase();

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        size="md"
        title={`Offboard ${name}?`}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!ready}
              onClick={() => void confirm()}
            >
              Offboard
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {loading ? (
            <div role="status" aria-label="Reading the plan" className="flex flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          ) : loadError ? (
            <Callout tone="danger">{errorMessage(loadError)}</Callout>
          ) : plan ? (
            <>
              {blockers.length ? (
                <Callout tone="danger">
                  {blockers.map((b) => `${b.org.name} would lose its last admin.`).join(' ')}
                </Callout>
              ) : null}
              <ul className="list-disc pl-5 text-sm text-fg">
                {planLines(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          <FormField label={`Type ${word} to confirm`} error={error}>
            {(c) => (
              <Input
                {...c}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ready && !busy) void confirm();
                }}
              />
            )}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
