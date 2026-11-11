import type { ScanCard } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { CommittedScanUnconfirmed, StaleScanAuthority } from './act-override.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { confirmAssetGrantToken } from './assets.ts';
import { readCard, readyOutcome, renderCardDisplay } from './card.ts';
import { planCounts } from './counts.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import { confirmedPhotoUrl, type PreparedPhotoGrant } from './member-photo.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import type { Found } from './resolve.ts';
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
  csrfSnapshot: ActorCsrfSnapshot;
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
    csrfSnapshot,
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
  const passViewPlan = await prepareAssetGrantInsertion(
    ctx,
    passViewGrant,
    { recipientSnapshot: csrfSnapshot },
    found.liveCandidate,
  );
  const photoPlan = photo
    ? await prepareAssetGrantInsertion(
        ctx,
        photo.grant,
        { recipientSnapshot: csrfSnapshot },
        found.liveCandidate,
        { soft: true },
      )
    : null;
  const g = scanWriteGrant(ctx, authorityActor, {
    purpose: 'org_mode.scan.stop',
    now: ctx.clock.now(),
    event: found.admission?.event ?? null,
    pass: { id: found.pass.id, facts: { pass: found.pass, credential: {} } },
  });
  const released = g.delete('scans', {
    where: { id: scanId, state: 'pending', at: claimAt },
    returning: ['id'],
  });
  const committed = await g.commit();
  if (!(committed[g.indexOf(released)]?.results ?? []).length) {
    onFailureCommitted();
    throw stale();
  }
  // The pending key is released. The card needs its pass view grant, so a failure here is an error
  // the client can retry with the same key; the photo and history only decorate it.
  const now = ctx.clock.now();
  const open = { sql: '1', params: [] };
  const bound = displayHistory.bind(now, open);
  const passViewInsert = passViewPlan(now, boundOutputPredicate(open), open);
  const photoInsert = photoPlan ? photoPlan(now, boundOutputPredicate(open), open) : [];
  const results = await ctx.env.DB.batch([...passViewInsert, ...photoInsert, ...bound.stmts]);
  const history = bound.finalize(results.slice(passViewInsert.length + photoInsert.length));
  if (!history) throw new CommittedScanUnconfirmed();
  const passViewToken = confirmAssetGrantToken(
    passViewGrant,
    results.slice(0, passViewInsert.length),
  );
  if (!passViewToken) throw new CommittedScanUnconfirmed();
  const photoUrl = photo
    ? confirmedPhotoUrl(
        authorityActor,
        found.pass.id,
        photo.grant,
        results.slice(passViewInsert.length, passViewInsert.length + photoInsert.length),
      )
    : null;
  const card: ScanCard = { ...draft, passView: { ...draft.passView, assetGrant: passViewToken } };
  renderCardDisplay(ctx, actor, found, card, history, photoUrl);
  return {
    outcome: readyOutcome(card, read),
    evaluatedSnapshot: found.liveCandidate,
    credentialContext: credentials,
  };
}
