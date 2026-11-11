import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { type VerifiedHistoryProof, verifyHistoryProofRow } from './history-proof.ts';
import type { PassScope } from './repo-history-proof-plan-query.ts';
import type { HistoryProofRow } from './repo-history-proof-read.ts';
import type { Found } from './resolve.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';

export { countStmt, type PassScope, pageStmt } from './repo-history-proof-plan-query.ts';

export interface HistoryOrgScope {
  orgId: string;
  mode: Mode;
  credentialKeysetCommitment: string;
}
export interface DecodedPage {
  ids: string[];
  proofs: Map<string, VerifiedHistoryProof>;
}

export async function decodePage(
  ctx: ServiceContext,
  rows: readonly HistoryProofRow[],
  scope: HistoryOrgScope,
  allowed: (row: HistoryProofRow) => boolean,
  cache: ScanEventProofCache,
): Promise<DecodedPage | null> {
  const ids: string[] = [];
  const unique = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.id !== 'string' ||
      unique.has(row.id) ||
      row.org_id !== scope.orgId ||
      row.mode !== scope.mode ||
      !allowed(row)
    )
      return null;
    unique.add(row.id);
    ids.push(row.id);
  }
  const verified = await Promise.all(
    rows.map((row) => verifyHistoryProofRow(ctx, row, scope.credentialKeysetCommitment, cache)),
  );
  const proofs = new Map<string, VerifiedHistoryProof>();
  ids.forEach((id, index) => {
    const proof = verified[index];
    if (proof) proofs.set(id, proof);
  });
  return { ids, proofs };
}

export function passScope(ctx: ServiceContext, actor: ScanActor, found: Found): PassScope {
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    eventId: actor.event?.id ?? actor.scannerAssignment?.eventId ?? null,
    credentialKeysetCommitment: found.credentialKeysetCommitment,
    until: ctx.clock.now(),
  };
}
