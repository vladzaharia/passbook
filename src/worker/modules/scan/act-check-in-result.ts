import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { completedAdmission } from './admission.ts';
import type { CountsRead } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { recordResult } from './ledger.ts';
import { confirmedPhotoUrl, type PreparedPhotoGrant } from './member-photo.ts';
import { blankOutcome, safeDisplay, safeOutcomeDetails } from './outcome.ts';
import { activeFlags, type Found } from './resolve.ts';
import type { FinalizedDisplayHistory } from './scan-display-history.ts';

interface CheckInResult {
  ctx: ServiceContext;
  actor: ScanActor;
  authorityActor: ScanActor;
  found: Found;
  action: ResolvedScanAction;
  scanId: string;
  now: number;
  undoWindow: number;
  read: CountsRead;
  display: {
    finalize(results: readonly D1Result[]): FinalizedDisplayHistory | null;
    results: D1Result[];
  };
  photo: PreparedPhotoGrant | null;
  photoResults: D1Result[];
  hasPresence: boolean;
}

/**
 * Render the committed check-in. The gate and finalize are certain by now, so a display or photo that
 * cannot be confirmed degrades to a plainer card; it never turns a recorded scan into an error.
 */
export function finishCheckInResult(input: CheckInResult): ScanOutcome {
  const { ctx, actor, authorityActor, found, action, scanId, now, undoWindow, read } = input;
  const details = safeOutcomeDetails(
    found,
    actor,
    action,
    activeFlags(found, actor).map((flag) => flag.label),
  );
  const photoUrl = input.photo
    ? confirmedPhotoUrl(authorityActor, found.pass.id, input.photo.grant, input.photoResults)
    : null;
  recordResult(ctx, actor, found.pass.templateId, 'ok');
  const arrived = read.counts.event?.arrived ?? 0;
  const expected = read.counts.event?.expected ?? 0;
  const history = input.display.finalize(input.display.results);
  return {
    ...blankOutcome('ok', read),
    scanId,
    ...details,
    at: now,
    milestone:
      read.counts.event && expected > 0 && arrived === expected
        ? 'all_in'
        : arrived > 0 && Math.floor(arrived / 100) > Math.floor((arrived - 1) / 100)
          ? 'count'
          : null,
    undoUntil: now + undoWindow * 60_000,
    display: history
      ? safeDisplay(ctx, actor, found.pass, 'ok', { found, history, photoUrl })
      : null,
    checkIn: found.admission ? completedAdmission(found.admission, now) : undefined,
  };
}
