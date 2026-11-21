import type { Mode } from '../../../shared/contracts/common.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { BootCard } from '../ui/boot-card.tsx';
import { fill, UI_COPY } from '../ui/copy.ts';

/** A pairing link was opened: show who this would be before consuming anything. */
export function PairConfirm({
  scannerName,
  sessionName,
  orgName,
  mode,
  onPair,
  onCancel,
  error,
  busy,
}: {
  scannerName: string;
  /** The session the device joins; a legacy scanner has none, so its own name stands in. */
  sessionName?: string | null;
  orgName: string;
  mode?: Mode;
  onPair: () => void;
  onCancel: () => void;
  error?: string | null;
  busy?: boolean;
}) {
  return (
    <BootCard
      title={fill(UI_COPY.confirmTitle, { session: sessionName ?? scannerName })}
      scene="wave"
      line={fill(UI_COPY.confirmLine, { org: orgName, mode: mode === 'test' ? 'Test' : 'Live' })}
      testId="scan-pair-confirm"
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <div className="scan-card-actions">
        <Button variant="secondary" size="lg" onClick={onCancel}>
          {SCAN_COPY.actions.cancel}
        </Button>
        <Button size="lg" loading={busy} onClick={onPair}>
          {SCAN_COPY.actions.join}
        </Button>
      </div>
    </BootCard>
  );
}
