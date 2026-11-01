import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from './button.tsx';
import { Dialog, DialogContent } from './dialog.tsx';
import { FormField } from './field.tsx';
import { Input } from './input.tsx';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The word to type: the title when it is short, else the slug, else "delete". Never an id. */
export function confirmWord({ title, slug }: { title?: string | null; slug?: string | null }) {
  const t = title?.trim();
  if (t && t.length <= 24 && !UUID.test(t)) return t;
  const s = slug?.trim();
  if (s && !UUID.test(s)) return s;
  return 'delete';
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A destructive confirm that needs a human word typed (case-insensitive, trimmed). A check pops
 * in the field when it matches and the danger button fades in. No X; stays open on failure.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  word,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  word: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
}) {
  if (import.meta.env.DEV && UUID.test(word.trim())) {
    throw new Error('TypedConfirmDialog: use a human word (title, slug or "delete"), not an id.');
  }
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const matches = same(typed, word);
  useEffect(() => {
    if (!open) {
      setTyped('');
      setError(undefined);
    }
  }, [open]);

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
        closeButton={false}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!matches}
              className="transition-[opacity,background-color] duration-(--wl-dur-hover)"
              onClick={confirm}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <FormField label={`Type ${word} to confirm`} error={error}>
          {(c) => (
            <div className="relative">
              <Input
                {...c}
                data-autofocus
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="pr-9"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches && !busy) void confirm();
                }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-center"
              >
                {matches ? <Check className={cn('wl-check size-4 text-success')} /> : null}
              </span>
            </div>
          )}
        </FormField>
      </DialogContent>
    </Dialog>
  );
}
