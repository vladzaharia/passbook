import type { EventRow } from '../../events/repo.ts';
import {
  type PreparedScanRetentionProof,
  prepareSystemScanRetentionProof,
} from '../scan-retention-proof.ts';
import type { MarkOutScan } from './repo-mark-out.ts';

/** The desk's ledger row with its console authority, and the proof signed for it and the scan row `s`. */
export async function signMarkOut(
  env: object,
  ledger: EventRow,
  s: MarkOutScan,
): Promise<{ event: EventRow; retention: PreparedScanRetentionProof }> {
  const event = {
    ...ledger,
    data: JSON.stringify({
      ...JSON.parse(ledger.data),
      authority: { kind: 'console', purpose: 'org_mode.scan.check_in' },
    }),
  };
  const retention = await prepareSystemScanRetentionProof(env, event, {
    id: s.id,
    orgId: event.org_id,
    mode: event.mode,
    templateId: s.templateId,
    scannerId: s.scannerId,
    eventId: s.eventId,
    actorType: s.actorType,
    actorId: s.actorId,
    actorKey: s.actorKey,
    staffId: s.staffId,
    approvedBy: null,
    method: 'manual',
    state: 'done',
    outcome: 'ok',
    reason: null,
    actionId: null,
    actionKind: null,
    direction: 'out',
    passVersion: s.passVersion,
    presenceScope: s.place,
    at: s.now,
    undoes: null,
    override: false,
    outCause: 'desk',
  });
  return { event, retention };
}
