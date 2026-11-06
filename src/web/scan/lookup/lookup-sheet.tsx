import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { FormField } from '../../ui/field.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';

type Found = z.infer<typeof ScanLookupResultSchema>;
export function LookupSheet({
  open,
  onClose,
  api,
  onRead,
}: {
  open: 'lookup' | 'code' | null;
  onClose: () => void;
  api: ScanApi;
  onRead: (read: { code: string } | { passId: string }) => void;
}) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Found | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setQ('');
      setResult(null);
      setError('');
    }
  }, [open]);
  useEffect(() => {
    if (open !== 'lookup' || q.trim().length < 3) {
      setResult(null);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      setError('');
      void api
        .lookup({ q: q.trim() }, { signal: ac.signal })
        .then(
          (data) => {
            if (!ac.signal.aborted) setResult(data);
          },
          (e) => {
            if (!ac.signal.aborted) setError(errorMessage(e));
          },
        )
        .finally(() => {
          if (!ac.signal.aborted) setBusy(false);
        });
    }, 250);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [q, api, open]);
  return (
    <Dialog
      open={open !== null}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent title={open === 'code' ? 'Type a code' : 'Look up'} size="sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (open === 'code' && q.trim()) onRead({ code: q.trim() });
          }}
          className="flex flex-col gap-4"
        >
          <FormField label={open === 'code' ? 'Code' : 'Name or full email'}>
            {(props) => (
              <ScanTextField
                {...props}
                data-scan-code
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onValueRestore={setQ}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
            )}
          </FormField>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {open === 'code' ? (
            <Button type="submit" disabled={!q.trim()}>
              Check pass
            </Button>
          ) : (
            <>
              {busy ? <p role="status">Searching…</p> : null}
              {result?.items.map((row) => (
                <button
                  type="button"
                  className="rounded-xl border border-line p-3 text-start"
                  key={row.passId}
                  onClick={() => onRead({ passId: row.passId })}
                >
                  <span className="block font-semibold">{row.title}</span>
                  <span className="block text-sm text-fg-muted">
                    {[row.subtitle, row.maskedEmail, row.templateName].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
              {result && !result.items.length && !busy ? <p>No matches.</p> : null}
              {result?.more ? <p>Keep typing to narrow the list.</p> : null}
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
