import type { ScanCard } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { CommittedScanUnconfirmed, StaleScanAuthority } from './act-override.ts';
import { afterCommit } from './after-commit.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import { readCard, readyOutcome, renderCardDisplay } from './card.ts';
import { planCounts } from './counts.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import { type PreparedPhotoGrant, photoGrantUrl } from './member-photo.ts';
import { candidateTemplateFenceStmt, templateFenceHolds } from './repo-resolve-outcome-current.ts';
import type { Found } from './resolve.ts';
import { afterReads, capturingDb } from './scan-capture.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { scanWriteGrant } from './scan-write-grant.ts';

interface ChooseInput {
  ctx: ServiceContext;
  actor: ScanActor;
  authorityActor: ScanActor;
  req: ActRequest;
  scanId: string;
  claimAt: number;
  requestHash: string;
  credentials: CredentialTombstoneSnapshot;
  found: Found;
  photo: PreparedPhotoGrant | null;
  undoWindow: number;
  history?: PreloadedDisplayHistory;
  onFailureCommitted(): void;
}

/** Release the pending action only with its card, history and grants in one authority batch. */
export async function chooseAction(input: ChooseInput): Promise<ScanEvaluation> {
  const {
    ctx,
    actor,
    authorityActor,
    req,
    scanId,
    claimAt,
    credentials,
    found,
    photo,
    undoWindow,
    history: preloaded,
    onFailureCommitted,
  } = input;
  const stale = () => new StaleScanAuthority();
  const readNow = ctx.clock.now();
  const counts = planCounts(
    { ...ctx, clock: { now: () => readNow } },
    actor,
    req.dayStart,
    authorityActor,
    {
      sql: '1',
      params: [],
    },
  );
  const cardRead = await readCard(
    ctx,
    actor,
    found,
    counts,
    'read',
    undoWindow,
    preloaded,
    authorityActor,
  );
  if (!cardRead || !found.liveCandidate) throw stale();
  const { card: draft, passViewGrant, read, displayHistory } = cardRead;
  const g = scanWriteGrant(ctx, authorityActor, {
    purpose: 'org_mode.scan.stop',
    now: ctx.clock.now(),
    event: found.admission?.event ?? null,
    pass: { id: found.pass.id, facts: { pass: found.pass, credential: {} } },
    credentialRefs: credentials.credentialTombstoneRefs,
  });
  const released = g.delete('scans', {
    where: { id: scanId, state: 'pending', at: claimAt },
    returning: ['id'],
  });
  // The card was read under a template snapshot: it is served only while that snapshot still stands.
  const committed = await g.commitWith(
    afterReads([candidateTemplateFenceStmt(capturingDb(ctx.env.DB), found.liveCandidate)]),
  );
  if (!(committed.writes[g.indexOf(released)]?.results ?? []).length) {
    onFailureCommitted();
    throw stale();
  }
  if (!templateFenceHolds(committed.after[0])) throw new CommittedScanUnconfirmed();
  // The pending key is released. The card needs its history, so a failure here is an error the
  // client can retry with the same key; the photo only decorates it.
  const now = ctx.clock.now();
  const bound = displayHistory.bindAfterCommit(now, afterCommit(committed));
  const history = bound.finalize(bound.stmts.length ? await ctx.env.DB.batch(bound.stmts) : []);
  if (!history) throw new CommittedScanUnconfirmed();
  const passViewToken = takeAssetGrantToken(passViewGrant);
  if (!passViewToken) throw new CommittedScanUnconfirmed();
  const photoUrl = photo ? photoGrantUrl(authorityActor, found.pass.id, photo.grant) : null;
  const card: ScanCard = { ...draft, passView: { ...draft.passView, assetGrant: passViewToken } };
  renderCardDisplay(ctx, actor, found, card, history, photoUrl);
  return {
    outcome: readyOutcome(card, read),
    evaluatedSnapshot: found.liveCandidate,
    credentialContext: credentials,
  };
}
