import type { Json } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { visibleSource } from './card-semantics.ts';
import type { CountsRead } from './counts.ts';
import { buildDisplay } from './display.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ValueEffect } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import { recordResult } from './ledger.ts';
import { blankOutcome, safeOutcomeDetails } from './outcome.ts';
import { activeFlags, type Found } from './resolve.ts';
import type { FinalizedDisplayHistory } from './scan-display-history.ts';

type ScanValue = NonNullable<ScanOutcome['value']>;

/** The change as the staff sees it, or null when its input is not theirs to see. */
export function scanValueOf(
  found: Found,
  actor: ScanActor,
  action: ResolvedScanAction,
  before: Json,
  after: Json,
): ScanValue | null {
  const input = action.input;
  if (!input) return null;
  try {
    const privacy = cardPrivacy(found, actor);
    if (!visibleSource(found, actor, input, privacy) || !privacy.valueSafe(after)) return null;
    const prop = found.template.manifest.inputs.properties?.[input] as
      | { type?: string; title?: string; 'x-label'?: string; 'x-format'?: string }
      | undefined;
    const label = prop?.['x-label'] ?? prop?.title ?? input;
    const stamps = found.template.manifest.stamps;
    const goal =
      stamps?.input === input
        ? stamps.goal
        : action.kind === 'take' && typeof action.amount === 'number'
          ? action.amount
          : null;
    return {
      input,
      label: privacy.safe(label) ? label : 'Value',
      before: privacy.valueSafe(before) ? before : null,
      after,
      goal,
      format:
        prop?.['x-format'] === 'currency'
          ? 'currency'
          : prop?.type === 'string'
            ? 'text'
            : 'number',
    };
  } catch {
    return null;
  }
}

/** A stamp card that this scan filled, or an amount that reached its reward. */
export function reachedReward(value: ScanValue | null): boolean {
  const { before, after, goal } = value ?? {};
  return (
    typeof before === 'number' &&
    typeof after === 'number' &&
    typeof goal === 'number' &&
    before < goal &&
    after >= goal
  );
}

interface ValueResult {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  pass: Pass;
  action: ResolvedScanAction;
  scanId: string;
  now: number;
  undoWindow: number;
  read: CountsRead;
  effect: ValueEffect;
  amount: number | null;
  history: FinalizedDisplayHistory | null;
}

/** The committed value scan: its change, the screen rendered from the pass as it now stands, and the milestone. */
export function finishValueResult(i: ValueResult): ScanOutcome {
  const { ctx, actor, found, action, effect, read } = i;
  const details = safeOutcomeDetails(
    found,
    actor,
    action,
    activeFlags(found, actor).map((flag) => flag.label),
  );
  recordResult(ctx, actor, found.pass.templateId, 'ok');
  const value = scanValueOf(found, actor, action, effect.before, effect.after);
  return {
    ...blankOutcome('ok', read),
    scanId: i.scanId,
    ...details,
    at: i.now,
    value,
    milestone: reachedReward(value) ? 'reward' : null,
    undoUntil: i.now + i.undoWindow * 60_000,
    display: i.history ? displayOf(i, value) : null,
  };
}

function displayOf(i: ValueResult, value: ScanOutcome['value']): ScanOutcome['display'] {
  const { ctx, actor, found, action, effect, pass } = i;
  const next: Found = {
    ...found,
    pass,
    passJson: effect.status === 'voided' ? { ...found.passJson, voided: true } : found.passJson,
  };
  try {
    return buildDisplay(ctx, {
      actor,
      pass: { id: pass.id, title: pass.displayTitle ?? '' },
      screen: 'ok',
      template: next,
      history: i.history,
      scan: {
        action: { id: action.id, label: action.label, kind: action.kind },
        outcome: 'ok',
        at: i.now,
        ...(value ? { input: value.input, before: value.before, after: value.after } : {}),
        ...(i.amount !== null ? { amount: i.amount } : {}),
      },
    });
  } catch {
    ctx.log.error('scan.display_failed', { code: 'SCAN_DISPLAY_FAILED', screen: 'ok' });
    return null;
  }
}
