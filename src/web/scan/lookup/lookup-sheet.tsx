import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { FormField } from '../../ui/field.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { ScanApiError } from '../api/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';
import { scanId } from '../platform/id.ts';
import { LookupResults } from './lookup-results.tsx';
import './lookup.css';

const PassPreview = lazy(() =>
  import('../result/pass-preview.tsx').then((m) => ({ default: m.PassPreview })),
);

type Found = z.infer<typeof ScanLookupResultSchema>;
export function LookupSheet({
  open,
  onClose,
  api,
  onRead,
  orgId,
  timeZone,
}: {
  open: 'lookup' | 'code' | null;
  onClose: () => void;
  api: ScanApi;
  onRead: (read: { code: string } | { passId: string }) => void;
  orgId?: string;
  timeZone?: string;
}) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Found | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [picked, setPicked] = useState<ScanOutcome | null>(null);
  const [codeConfirm, setCodeConfirm] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const selectController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) {
      selectController.current?.abort();
      setQ('');
      setResult(null);
      setError('');
      setPicked(null);
      setCodeConfirm('');
      setBusy(false);
    }
    return () => selectController.current?.abort();
  }, [open]);
  useEffect(() => {
    if (!retryAt) return;
    const update = () => {
      const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSeconds(left);
      if (!left) setRetryAt(0);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    if (open !== 'lookup' || q.trim().length < 3 || retryAt || picked) {
      setBusy(false);
      if (q.trim().length < 3) setResult(null);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(
      () => {
        setBusy(true);
        setError('');
        void api
          .lookup({ q: q.trim() }, { signal: ac.signal })
          .then(
            (data) => {
              if (!ac.signal.aborted) setResult(data);
            },
            (e) => {
              if (ac.signal.aborted) return;
              setResult(null);
              if (e instanceof ScanApiError && e.status === 429)
                setRetryAt(Date.now() + (e.retryAfterMs ?? 40_000));
              else setError('Could not search. Check your connection.');
            },
          )
          .finally(() => {
            if (!ac.signal.aborted) setBusy(false);
          });
      },
      retry ? 0 : 250,
    );
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [q, api, open, retry, retryAt, picked]);
  useEffect(() => {
    if (picked) heading.current?.focus();
  }, [picked]);
  const pick = (
    input: { passId: string; method: 'manual' } | { code: string; method: 'manual' },
  ) => {
    selectController.current?.abort();
    const ac = new AbortController();
    selectController.current = ac;
    setBusy(true);
    setError('');
    void api
      .resolve({ idempotencyKey: scanId(), input, clientTs: Date.now() }, { signal: ac.signal })
      .then(
        (data) => {
          if (!ac.signal.aborted) {
            setPicked(data);
            setCodeConfirm('code' in input ? input.code : '');
          }
        },
        (e) => {
          if (!ac.signal.aborted) setError(errorMessage(e));
        },
      )
      .finally(() => {
        if (!ac.signal.aborted) setBusy(false);
      });
  };
  const card = picked?.card;
  const canCheck =
    picked?.kind === 'ready' && card?.actions.some((a) => a.kind === 'check_in' && a.available);
  return (
    <Sheet
      open={open !== null}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent
        side="left"
        title={open === 'code' ? 'Type a code' : 'Look up'}
        className="scan-lookup-sheet"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (picked || q) {
            event.preventDefault();
            if (picked) setPicked(null);
            else setQ('');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === '/') {
            e.preventDefault();
            field.current?.focus();
          }
          if (e.key === 'ArrowDown' && e.target === field.current) {
            e.preventDefault();
            document.querySelector<HTMLElement>('[data-lookup-result]')?.focus();
          }
        }}
      >
        <div className="scan-lookup-content">
          {picked ? (
            <div className="scan-lookup-confirm">
              <Button
                variant="ghost"
                iconStart={<ArrowLeft aria-hidden />}
                onClick={() => setPicked(null)}
              >
                Back
              </Button>
              {card ? (
                <Suspense fallback={<div className="scan-pass-preview" aria-hidden />}>
                  <PassPreview card={card} orgId={orgId} timeZone={timeZone} still />
                </Suspense>
              ) : null}
              <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
                {card?.title ?? 'Pass not available'}
              </h2>
              {card ? (
                <>
                  <p className="text-sm text-fg-muted">
                    {card.template.name}
                    {card.subtitle ? ` · ${card.subtitle}` : ''}
                  </p>
                  <p className="capitalize">{card.status}</p>
                </>
              ) : null}
              {picked.reason && picked.reason !== 'choose' ? (
                <Callout tone={picked.kind === 'refused' ? 'danger' : 'warning'}>
                  {SCAN_REASON_COPY[picked.reason].headline}
                </Callout>
              ) : null}
              {canCheck ? (
                <Button
                  className="scan-lookup-commit"
                  onClick={() => {
                    if (card) onRead({ passId: card.passId });
                    else if (codeConfirm) onRead({ code: codeConfirm });
                  }}
                >
                  Check in
                </Button>
              ) : null}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (open === 'code' && q.trim()) pick({ code: q.trim(), method: 'manual' });
                else setRetry((n) => n + 1);
              }}
              className="flex flex-col gap-4"
            >
              <FormField label={open === 'code' ? 'Code' : 'Name or full email'}>
                {(props) => (
                  <ScanTextField
                    {...props}
                    ref={field}
                    data-scan-code
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onValueRestore={setQ}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={seconds > 0}
                  />
                )}
              </FormField>
              {error ? (
                <Callout tone="danger">
                  {error}
                  <Button variant="link" onClick={() => setRetry((n) => n + 1)}>
                    Retry
                  </Button>
                </Callout>
              ) : null}
              {seconds ? <p role="status">Too many lookups. Try again in {seconds} s.</p> : null}
              {open === 'code' ? (
                <Button type="submit" loading={busy} disabled={!q.trim() || seconds > 0}>
                  Find pass
                </Button>
              ) : (
                <LookupResults
                  result={result}
                  busy={busy}
                  query={q}
                  onPick={(passId) => pick({ passId, method: 'manual' })}
                />
              )}
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
