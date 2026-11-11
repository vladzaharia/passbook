import type { ScanCard, ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import { cardLastScans } from './card-last-scans.ts';
import type { CountsPlan, CountsRead } from './counts.ts';
import { buildCard, type CardDraft, cardAssetStmt, cardAssets, type GateSeen } from './dto.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { type PreloadedDisplayHistory, planDisplayHistoryRead } from './history-proof-plan.ts';
import { blankOutcome, safeDisplay, undoWindowMinutes } from './outcome.ts';
import {
  type CardHistoryFence,
  type CardHistoryRow,
  cardHistoryFence,
  cardHistoryStmt,
} from './repo-card-history.ts';
import { gatesOfPassStmt } from './repo-gates.ts';
import type { Found } from './resolve.ts';
import {
  type DisplayHistoryPlan,
  displayNeedsFor,
  type FinalizedDisplayHistory,
  prepareDisplayHistory,
} from './scan-display-history.ts';

/** Plan authenticated history before the final actor/pass snapshot. */
export function historyPlan(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  preloaded?: PreloadedDisplayHistory | null,
): Promise<DisplayHistoryPlan> {
  return prepareDisplayHistory(ctx, actor, found, displayNeedsFor(found), preloaded);
}

export interface CardRead {
  /** Display is empty until renderCardDisplay receives this plan's finalized history. */
  card: CardDraft;
  passViewGrant: PreparedAssetGrant;
  read: CountsRead;
  historyFence: CardHistoryFence | null;
  displayHistory: DisplayHistoryPlan;
}

/** Read card data; render the display only after its history and authority are finalized together. */
export async function readCard(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  counts: CountsPlan,
  grantPurpose: 'read' | 'commit',
  capturedUndoWindow?: number,
  preloaded?: PreloadedDisplayHistory | null,
  grantRecipientActor?: ScanActor,
): Promise<CardRead | null> {
  const db = ctx.env.DB;
  const historyScope = {
    orgId: actor.orgId,
    mode: actor.mode,
    passId: found.pass.id,
    templateId: found.pass.templateId,
  };
  const needs = displayNeedsFor(found);
  const historyRead =
    preloaded === undefined ? planDisplayHistoryRead(ctx, actor, found, needs) : null;
  const [results, undoWindow] = await Promise.all([
    db.batch([
      gatesOfPassStmt(db, found.pass.id),
      cardHistoryStmt(db, historyScope),
      ...counts.stmts,
      cardAssetStmt(db, found),
      ...(historyRead?.stmts ?? []),
    ]),
    capturedUndoWindow ?? undoWindowMinutes(ctx),
  ]);
  const scans = (results[1]?.results ?? []) as CardHistoryRow[];
  const historyStart = 3 + counts.stmts.length;
  const loaded = historyRead
    ? await historyRead.finish(results.slice(historyStart, historyStart + historyRead.stmts.length))
    : preloaded;
  if (!loaded) return null;
  const read = await counts.read(results.slice(2, 2 + counts.stmts.length));
  const [assetNames, projected, displayHistory] = await Promise.all([
    cardAssets(ctx, found, results[2 + counts.stmts.length]),
    cardLastScans(
      ctx,
      actor,
      found,
      cardPrivacy(found, actor),
      {
        scans,
        undoWindowMinutes: undoWindow,
      },
      ctx.clock.now(),
    ),
    prepareDisplayHistory(ctx, actor, found, needs, loaded),
  ]);
  if (!assetNames) return null;
  const historyFence = cardHistoryFence(historyScope, projected.selectedScans);
  const built = await buildCard(ctx, actor, {
    found,
    grantPurpose,
    ...(grantRecipientActor ? { grantRecipientActor } : {}),
    reads: {
      gates: (results[0]?.results ?? []) as GateSeen[],
      lastScans: projected.scans,
    },
    display: emptyDisplay(),
    assetNames,
  });
  if (!built) return null;
  return { ...built, read, historyFence, displayHistory };
}

/** `ScanCard.display` is required; a render failure must not expose cached identity data. */
function emptyDisplay(): ScanCard['display'] {
  return {
    v: 1,
    screen: 'ready',
    templateVersion: '',
    variant: null,
    identity: { holder: '', initials: '', photo: null },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

/** Render only history finalized with the response's actor/pass authority. */
export function renderCardDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  card: Pick<ScanCard, 'display'>,
  history: FinalizedDisplayHistory,
  photoUrl?: string | null,
): void {
  card.display =
    safeDisplay(ctx, actor, found.pass, 'ready', { found, history, photoUrl }) ?? emptyDisplay();
}

/** A `ready` answer: choose an action; the card is the body, the display stays on the card. */
export function readyOutcome(card: ScanCard, read: CountsRead): ScanOutcome {
  return {
    ...blankOutcome('ready', read),
    reason: 'choose',
    card,
    template: { name: card.template.name, style: card.template.style },
    checkIn: card.checkIn,
  };
}
