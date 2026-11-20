import { ChevronUp, Info } from 'lucide-react';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import type { ScanOutcome } from '../machine/types.ts';
import { GroupChip } from './group-chip.tsx';
import { KeyFact, keyFactOf } from './key-fact.tsx';

/**
 * What a glance card shows under the identity: the group, the one note an amber or red card
 * exists to deliver, or the key fact. A refusal also says where the rest is.
 */
export function GlanceTail({
  outcome: o,
  display,
  denied,
  notes,
  chip,
  onGroup,
}: {
  outcome: ScanOutcome;
  display: ScanDisplay | null;
  denied: boolean;
  notes: string[];
  chip: boolean;
  onGroup?: (() => void) | undefined;
}) {
  const instruction = o.kind === 'refused' || o.kind === 'heads_up';
  const fact = denied || chip || o.reason === 'needs_approval' ? null : keyFactOf(display);
  const note = notes[0];
  const showNote = note && (instruction || !fact) && !chip;
  return (
    <>
      {chip ? <GroupChip outcome={o} onGroup={onGroup} /> : null}
      {showNote ? (
        <div className="scan-result-notes" data-testid="scan-glance-note">
          <Info size={20} aria-hidden />
          <p>{note}</p>
        </div>
      ) : fact ? (
        <KeyFact fact={fact} />
      ) : null}
      {o.kind === 'refused' && (o.card || o.scanId) ? (
        <p aria-hidden className="scan-glance-more">
          {SCAN_HANDHELD_COPY.tapForDetails}
          <b>
            {SCAN_HANDHELD_COPY.why}
            <ChevronUp size={16} />
          </b>
        </p>
      ) : null}
    </>
  );
}
