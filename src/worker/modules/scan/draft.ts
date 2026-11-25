import { applyDefaults } from '../../../passkit/template/manifest.ts';
import { moneyText } from '../../../passkit/template/scan-display/format.ts';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import type { ScanDraftRequest } from '../../../shared/contracts/scan-draft.ts';
import { CUSTOMER_COPY } from '../../../shared/copy/scan-customer.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { pendingCap } from './act-value-guard.ts';
import {
  currencyField,
  moneyDigits,
  ScanEffectStop,
  valueEffect,
  valueRequestIssue,
} from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import { liveReadyId, scanHub } from './live.ts';
import { clip, fill } from './live-receipt.ts';
import { type Found, foundOf } from './resolve.ts';
import { resolveOutcome } from './resolve-outcome.ts';

const invalid = (message: string) => new ValidationError(message, [], 'SCAN_DRAFT_INVALID');
const stale = () => new ConflictError('That read is over. Scan again.', 'SCAN_DRAFT_STALE');

/** Only the paired scanner that publishes a ready card drafts: in a scanning session, or with screens watching it. */
function drafter(actor: ScanActor) {
  const scanner = actor.scanner;
  if (
    scanner?.deviceRole !== 'scan' ||
    actor.principal !== 'scanner' ||
    actor.terminal ||
    (!actor.scanningSession && !scanner.hasScreens)
  )
    throw new ForbiddenError('Only a paired scanner shows a draft.', 'DEVICE_REQUIRED');
  return { scannerId: scanner.id, orgId: actor.orgId, mode: actor.mode };
}

/**
 * What the customer would see: the money action, its figure and the balance after it, from the pass as
 * the server reads it now. Money `take` and `add` only, by the template's own rules for the amount, and
 * only an action this desk may run.
 */
async function sayFor(ctx: ServiceContext, found: Found, card: ScanCard, req: ScanDraftRequest) {
  const action = found.scan.actions.find((a) => a.id === req.actionId);
  const offered = card.actions.find((a) => a.id === req.actionId);
  if (!action || !offered || (action.kind !== 'take' && action.kind !== 'add') || !action.input)
    throw invalid('A draft shows money to take or add.');
  if (!offered.available && offered.lock !== 'approval')
    throw invalid('This action is not allowed here.');
  const { manifest } = found.template;
  const { pass } = found;
  const values = applyDefaults(manifest, pass.personalization);
  if (moneyDigits(manifest, action.input, values) === null)
    throw invalid('A draft shows money to take or add.');
  const body = { amount: req.amount };
  const issue = valueRequestIssue(action, manifest, body, pass.personalization);
  const cap = typeof action.amount === 'object' ? action.amount.max : Number.POSITIVE_INFINITY;
  if (issue || req.amount > cap)
    throw invalid(issue?.message ?? 'Enter an amount within the limit.');
  const { currency } = currencyField(manifest, action.input, pass.personalization);
  const money = (n: number) => moneyText(n, 'en', currency);
  let after: number | null = null;
  try {
    const effect = valueEffect(action, manifest, pass, body, await pendingCap(ctx, found, action));
    after = typeof effect.after === 'number' ? effect.after : null;
  } catch (error) {
    // A balance too small is the customer's to see: only the figure to pay shows.
    if (!(error instanceof ScanEffectStop && error.reason === 'no_balance'))
      throw invalid('This amount cannot apply to the card now. Enter another.');
  }
  return {
    headline: action.kind === 'take' ? CUSTOMER_COPY.toPay : CUSTOMER_COPY.adding,
    figure: clip(money(req.amount)),
    sub: after === null ? null : clip(fill(CUSTOMER_COPY.balanceAfter, { balance: money(after) })),
  };
}

/** A hub failure is logged and answers no screens: a draft never blocks the commit. */
async function told<T>(ctx: ServiceContext, orgId: string, send: () => Promise<T>, failed: T) {
  try {
    return await send();
  } catch (error) {
    ctx.log.error('scan.draft_publish_failed', {
      orgId,
      code: 'SCAN_DRAFT_PUBLISH_FAILED',
      error: error instanceof Error ? error.name : undefined,
    });
    return failed;
  }
}

/** Show a money draft on the customer screens that follow this scanner. */
export async function putDraft(ctx: ServiceContext, actor: ScanActor, req: ScanDraftRequest) {
  const { scannerId, orgId, mode } = drafter(actor);
  const readyId = await liveReadyId(scannerId, req.ref);
  const hub = scanHub(ctx, orgId, mode);
  const now = ctx.clock.now();
  const ready = await told(ctx, orgId, () => hub.ringRow(readyId, now), undefined);
  // A hub that cannot answer is no screen to tell: the draft never blocks the commit.
  if (ready === undefined) return { screens: 0 };
  if (!ready?.row.passId) throw stale();
  const { outcome, evaluatedSnapshot } = await resolveOutcome(ctx, actor, {
    idempotencyKey: req.ref,
    input: { passId: ready.row.passId, method: 'manual' },
    clientTs: now,
  });
  if (outcome.kind !== 'ready' || outcome.card?.passId !== ready.row.passId) throw stale();
  const found = evaluatedSnapshot ? await foundOf(ctx, evaluatedSnapshot) : null;
  if (!found) throw stale();
  const say = await sayFor(ctx, found, outcome.card, req);
  const screens = await told(
    ctx,
    orgId,
    () => hub.draft({ orgId, mode, readyId, scannerId, say, now }),
    0 as number | null,
  );
  if (screens === null) throw stale();
  return { screens };
}

/** Clear the draft and the ready card: the desk cancelled the read. */
export async function deleteDraft(
  ctx: ServiceContext,
  actor: ScanActor,
  query: { ref: string; keep?: 'ready' | undefined },
) {
  const { scannerId, orgId, mode } = drafter(actor);
  const readyId = await liveReadyId(scannerId, query.ref);
  const now = ctx.clock.now();
  const keep = query.keep ? { keep: query.keep } : {};
  const screens = await told(
    ctx,
    orgId,
    () => scanHub(ctx, orgId, mode).clearDraft({ orgId, mode, readyId, scannerId, now, ...keep }),
    0,
  );
  return { screens: screens ?? 0 };
}
