import { Hash, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { SCAN_TRAY_COPY as COPY } from '../../../shared/copy/scan-tray.ts';
import { ScanTextField } from '../input/wedge-field.tsx';
import { Keypad } from '../ui/keypad.tsx';
import { Tray } from '../ui/tray.tsx';
import { LookupConfirm } from './lookup-confirm.tsx';
import type { LookupPanelProps } from './lookup-panel.tsx';
import { LookupResults } from './lookup-results.tsx';
import { useLookup } from './use-lookup.ts';
import './lookup.css';

/**
 * Enter code on a handheld (design 6): the read-out over a keypad in the bottom third. ABC hands
 * the field to the system keyboard for a name; a partial match lists above the keys.
 */
export function LookupTray({
  open,
  api,
  onCheckIn,
  onCode,
  onPass,
  allowPeople = true,
  orgId,
  timeZone,
  onClose,
}: LookupPanelProps & { onClose: () => void }) {
  const lookup = useLookup(api, open, allowPeople, onCode, onPass);
  const { q, picked, busy, seconds, error, result } = lookup;
  const [letters, setLetters] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const editing = Boolean(q || picked);
  // Matches, or a line about them, list above the keys: the tray is as tall as its content.
  const grows = allowPeople
    ? Boolean(result?.items.length || error || seconds || (result && !busy))
    : Boolean(error || seconds);
  const lookUp = allowPeople ? COPY.lookUp : COPY.enter;
  const mode = (
    <button
      type="button"
      className="scan-key"
      data-kind="mode"
      aria-label={COPY.lettersLabel}
      onClick={() => {
        flushSync(() => setLetters(true));
        field.current?.focus();
      }}
    >
      {COPY.letters}
    </button>
  );
  return (
    <Tray
      label={COPY.enterCode}
      onClose={onClose}
      height={picked ? 588 : letters || grows ? undefined : 500}
      testId="scan-lookup-tray"
      onEscapeKeyDown={(event) => {
        if (editing) event.preventDefault();
      }}
    >
      <fieldset
        className="scan-tray-body min-w-0 border-0 p-0"
        aria-label="Pass lookup"
        data-lookup-editing={editing}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          if (picked) lookup.back();
          else if (q) lookup.change('');
          else return;
          e.stopPropagation();
        }}
      >
        {picked ? (
          <LookupConfirm
            picked={picked}
            busy={busy}
            onBack={lookup.back}
            {...(onPass ? {} : { onCheckIn })}
            orgId={orgId}
            timeZone={timeZone}
          />
        ) : (
          <form
            className="scan-code-form"
            onSubmit={(e) => {
              e.preventDefault();
              lookup.submit();
            }}
          >
            <p className="scan-code-cap">{COPY.codeLabel}</p>
            <div className="scan-code-row">
              <ScanTextField
                ref={field}
                data-autofocus
                data-scan-code
                aria-label={allowPeople ? COPY.field : COPY.fieldCode}
                className="scan-code-field"
                value={q}
                onChange={(e) => lookup.change(e.target.value)}
                onValueRestore={lookup.change}
                inputMode={letters ? 'text' : 'none'}
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={1024}
                disabled={seconds > 0}
              />
              <button
                type="button"
                className="scan-code-x"
                aria-label={COPY.close}
                onClick={onClose}
              >
                <X aria-hidden size={24} />
              </button>
            </div>
            <div className="scan-code-results">
              {error ? (
                <p className="scan-code-note" role="alert">
                  {error}{' '}
                  <button type="button" className="scan-code-retry" onClick={lookup.retry}>
                    Retry
                  </button>
                </p>
              ) : null}
              {seconds ? (
                <p className="scan-code-note" role="status">
                  {COPY.tooMany.replace('{n}', String(seconds))}
                </p>
              ) : null}
              {allowPeople ? (
                <LookupResults tray result={result} busy={busy} query={q} onPick={lookup.pick} />
              ) : null}
            </div>
            {letters ? null : (
              <Keypad
                disabled={seconds > 0}
                corner={allowPeople ? mode : undefined}
                onDigit={(digit) => lookup.change(q + digit)}
                onDelete={() => lookup.change(q.slice(0, -1))}
              />
            )}
            <div className="scan-code-keys">
              {letters ? (
                <button
                  type="button"
                  className="scan-tray-btn"
                  data-kind="mode"
                  aria-label={COPY.digitsLabel}
                  onClick={() => {
                    flushSync(() => setLetters(false));
                    field.current?.focus();
                  }}
                >
                  <Hash aria-hidden size={20} />
                  {COPY.digits}
                </button>
              ) : null}
              <button
                type="submit"
                className="scan-tray-btn"
                data-variant="filled"
                disabled={!q.trim() || seconds > 0 || lookup.selecting}
              >
                {lookUp}
              </button>
            </div>
          </form>
        )}
      </fieldset>
    </Tray>
  );
}
