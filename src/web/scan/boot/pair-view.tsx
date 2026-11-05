import { Lock, ScanLine } from 'lucide-react';
import { type FormEvent, type Ref, useId, useState } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { Label } from '../../ui/label.tsx';
import { BootCard } from '../ui/boot-card.tsx';
import { UI_COPY } from '../ui/copy.ts';

const PAIR_LENGTH = 10;

/** Pair this device: the pairing code (10 Crockford characters, 5 and 5) typed or scanned. */
export function PairView({
  onPair,
  onScan,
  error,
  busy,
  inputRef,
}: {
  onPair: (code: string) => void;
  /** Opens the camera to read a pairing QR. */
  onScan?: () => void;
  error?: string | null;
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === PAIR_LENGTH) onPair(code);
  };
  const b = SCAN_COPY.boot;
  return (
    <BootCard title={b.pairTitle} line={b.pairLine} testId="scan-pair">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>{b.pairLabel}</Label>
          <div data-testid="pair-code">
            <CodeField
              id={id}
              value={code}
              onChange={setCode}
              length={PAIR_LENGTH}
              group={5}
              alphabet="crockford"
              inputRef={inputRef}
              invalid={Boolean(error)}
            />
          </div>
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={busy}
          disabled={code.length < PAIR_LENGTH}
        >
          {SCAN_COPY.actions.pair}
        </Button>
        {onScan ? (
          <Button type="button" variant="secondary" size="lg" className="w-full" onClick={onScan}>
            <ScanLine aria-hidden />
            {UI_COPY.scanPairingCode}
          </Button>
        ) : null}
      </form>
      <p className="scan-card-line scan-pair-footer">
        <Lock aria-hidden size={16} />
        {b.pairFooter}
      </p>
    </BootCard>
  );
}
