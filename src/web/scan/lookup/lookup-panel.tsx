import { useEffect, useRef } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { FormField } from '../../ui/field.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';
import { LookupConfirm } from './lookup-confirm.tsx';
import { LookupResults } from './lookup-results.tsx';
import { useLookup } from './use-lookup.ts';
import './lookup.css';

export interface LookupPanelProps {
  open: boolean;
  api: ScanApi;
  onCheckIn: (card: ScanCard, actionId: string) => void;
  onCode: (code: string) => void;
  allowPeople?: boolean;
  orgId?: string;
  timeZone?: string;
  inline?: boolean;
  onEditing?: (editing: boolean) => void;
}
export function LookupPanel({
  open,
  api,
  onCheckIn,
  onCode,
  allowPeople = true,
  orgId,
  timeZone,
  inline = false,
  onEditing,
}: LookupPanelProps) {
  const lookup = useLookup(api, open, allowPeople, onCode);
  const { q, picked, busy, seconds, error, result } = lookup;
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!picked && open && !inline) field.current?.focus();
  }, [picked, open, inline]);
  useEffect(() => {
    onEditing?.(Boolean(q || picked));
  }, [q, picked, onEditing]);
  return (
    <fieldset
      className="scan-lookup-content min-w-0 border-0"
      aria-label="Pass lookup"
      data-lookup-editing={Boolean(q || picked)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (picked) lookup.back();
          else lookup.change('');
        }
        if (e.key === 'ArrowDown' && e.target === field.current) {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLElement>('[data-lookup-result]')?.focus();
        }
      }}
    >
      {picked ? (
        <LookupConfirm
          picked={picked}
          busy={busy}
          onBack={lookup.back}
          onCheckIn={onCheckIn}
          orgId={orgId}
          timeZone={timeZone}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            lookup.submit();
          }}
          className="flex flex-col gap-4"
        >
          <FormField label={allowPeople ? 'Name, email or code' : 'Code'}>
            {(props) => (
              <ScanTextField
                {...props}
                ref={field}
                data-scan-code
                data-operator-search={inline || undefined}
                value={q}
                onChange={(e) => lookup.change(e.target.value)}
                onValueRestore={lookup.change}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={1024}
                disabled={seconds > 0}
              />
            )}
          </FormField>
          <Button
            type="submit"
            loading={lookup.selecting}
            disabled={!q.trim() || seconds > 0 || lookup.selecting}
          >
            Find pass
          </Button>
          {error ? (
            <Callout tone="danger">
              {error}
              <Button variant="link" onClick={lookup.retry}>
                Retry
              </Button>
            </Callout>
          ) : null}
          {seconds ? <p role="status">Too many lookups. Try again in {seconds} s.</p> : null}
          {allowPeople ? (
            <LookupResults result={result} busy={busy} query={q} onPick={lookup.pick} />
          ) : (
            <p className="text-sm text-fg-muted">Enter the full code and press Enter.</p>
          )}
        </form>
      )}
    </fieldset>
  );
}
