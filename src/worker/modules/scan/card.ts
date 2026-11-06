import { compileNeeds, defaultScanDisplay } from '../../../passkit/template/scan-display/index.ts';
import type { ScanCard, ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CountsPlan, CountsRead } from './counts.ts';
import { historyStatements } from './display.ts';
import { buildCard, cardAssets, type GateSeen, type ScanSeen } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { blankOutcome, safeDisplay, undoWindowMinutes } from './outcome.ts';
import { gatesOfPassStmt } from './repo-gates.ts';
import { lastScansStmt } from './repo-scans.ts';
import type { Found } from './resolve.ts';

/** The statements a result display needs beyond the pass: its history, joined into the request's batch. */
export function historyPlan(ctx: ServiceContext, actor: ScanActor, found: Found) {
  const doc = found.scan.display ?? defaultScanDisplay(found.template.manifest, found.passJson);
  return historyStatements(ctx.env.DB, compileNeeds(doc), {
    passId: found.pass.id,
    orgId: found.pass.orgId,
    timeZone: actor.timeZone,
    now: ctx.clock.now(),
  });
}

/**
 * The desk card: the pass, its gates, its last scans, the display's history and the counts, in one
 * batch (SA 13.1). Writes no scan row.
 */
export async function readCard(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  counts: CountsPlan,
): Promise<{ card: ScanCard; read: CountsRead }> {
  const db = ctx.env.DB;
  const history = historyPlan(ctx, actor, found);
  const [results, assetNames, undoWindow] = await Promise.all([
    db.batch([
      gatesOfPassStmt(db, found.pass.id),
      lastScansStmt(db, actor.orgId, found.pass.id),
      ...counts.stmts,
      ...history.stmts,
    ]),
    cardAssets(ctx, found),
    undoWindowMinutes(ctx),
  ]);
  const read = await counts.read(results.slice(2, 2 + counts.stmts.length));
  const display = safeDisplay(ctx, actor, found.pass, 'ready', {
    found,
    history: history.read(results.slice(2 + counts.stmts.length)),
  });
  const card = await buildCard(ctx, actor, {
    found,
    reads: {
      gates: (results[0]?.results ?? []) as GateSeen[],
      scans: (results[1]?.results ?? []) as ScanSeen[],
      undoWindowMinutes: undoWindow,
    },
    display: display ?? emptyDisplay(found),
    assetNames,
  });
  return { card, read };
}

/** `ScanCard.display` is required; a render failure still gives the identity row. */
function emptyDisplay(found: Found): ScanCard['display'] {
  const holder = (found.pass.displayTitle ?? '').slice(0, 40);
  return {
    v: 1,
    screen: 'ready',
    templateVersion: '',
    variant: null,
    identity: { holder, initials: '', photo: null },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

/** A `ready` answer: choose an action; the card is the body, the display stays on the card. */
export function readyOutcome(found: Found, card: ScanCard, read: CountsRead): ScanOutcome {
  return {
    ...blankOutcome('ready', read),
    reason: 'choose',
    card,
    template: found.ref,
    checkIn: found.admission?.state,
  };
}
