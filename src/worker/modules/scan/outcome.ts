import type {
  ScanCard,
  ScanOutcome,
  ScanOutcomeKind,
  ScanReason,
} from '../../../shared/contracts/scan.ts';
import type { ScanDisplay, ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { sourcePolicyProven, visibleSource } from './card-semantics.ts';
import type { CountsRead } from './counts.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { buildDisplay } from './display.ts';
import { policyActor } from './dto.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import type { Found, Stop } from './resolve.ts';
import { activeFlags } from './resolve.ts';
import { overridePolicyKind, ROLE_RANK, scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

/** Heads-ups a person with the right (or a Manager's PIN) may let through (SA 2.6). */
const OVERRIDABLE = new Set<ScanReason>([
  'already_done',
  'cooldown',
  'not_yet_valid',
  'ended',
  'capacity_full',
]);

export const isOverridable = (reason: ScanReason | null): boolean =>
  reason !== null && OVERRIDABLE.has(reason);

export function blankOutcome(kind: ScanOutcomeKind, read: CountsRead): ScanOutcome {
  return {
    scanId: null,
    kind,
    reason: null,
    replay: false,
    action: null,
    card: null,
    previous: null,
    template: null,
    at: null,
    cooldownRemainingMs: null,
    value: null,
    flags: [],
    overridable: false,
    approvals: read.approvals,
    group: null,
    counts: read.counts,
    milestone: null,
    undoUntil: null,
    access: null,
    display: null,
  };
}

/** A stale authority snapshot must not disclose any pass or scope data. */
export function unknownOutcome(
  credentialContext: CredentialTombstoneSnapshot | null = null,
): ScanEvaluation {
  return {
    outcome: {
      ...blankOutcome('refused', {
        approvals: false,
        counts: { today: 0, event: null, asOf: 0, configRev: 0 },
      }),
      reason: 'not_found',
    },
    evaluatedSnapshot: null,
    credentialContext,
  };
}

/** A scanner whose scope accepts nothing (an invalid or empty event-bound session) is told so, and nothing is written. */
export function notAcceptedOutcome(
  credentialContext: CredentialTombstoneSnapshot | null = null,
): ScanEvaluation {
  const refused = unknownOutcome(credentialContext);
  return { ...refused, outcome: { ...refused.outcome, reason: 'not_accepted' } };
}

/** The display for a screen. Never throws: a render error is logged and the verdict goes out without one. */
export function safeDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  pass: { id: string; displayTitle: string | null } | null,
  screen: ScanDisplayScreen,
  more: { found?: Found; history?: unknown; photoUrl?: string | null } = {},
): ScanDisplay | null {
  if (!pass) return null;
  try {
    return buildDisplay(ctx, {
      actor,
      pass: { id: pass.id, title: pass.displayTitle ?? '' },
      screen,
      template: more.found,
      history: more.history,
      photoUrl: more.photoUrl,
    });
  } catch {
    ctx.log.error('scan.display_failed', { code: 'SCAN_DISPLAY_FAILED', screen });
    return null;
  }
}

/** Whether Let in again is offered for this heads-up, and to whom (a Manager PIN counts). */
export function canOverride(
  actor: ScanActor,
  reason: ScanReason | null,
  action: ResolvedScanAction | null,
  approvals: boolean,
): boolean {
  if (!isOverridable(reason)) return false;
  if (action?.kind === 'check_in' && action.allowAgain === false) return false;
  const verdict = scanPolicy(policyActor(actor), {
    kind: overridePolicyKind(reason),
  });
  return verdict.allow || (verdict.why === 'needs_approval' && approvals);
}

const NO_DISPLAY = new Set<ScanReason>(['test_pass', 'live_pass']);

/** Project response metadata only from the evaluated pass and the current actor's policy. */
export function safeOutcomeDetails(
  found: Found | null,
  actor: ScanActor,
  action: ResolvedScanAction | null,
  flags: string[],
  currentActionLabel?: string,
): Pick<ScanOutcome, 'action' | 'template' | 'flags'> {
  const hidden = { action: null, template: null, flags: [] };
  if (!found || actor.role === null || !sourcePolicyProven(found, actor)) return hidden;
  try {
    const privacy = cardPrivacy(found, actor);
    const current =
      action &&
      found.scan.actions.find(
        (item) => item.id === action.id && item.kind === action.kind && item.label === action.label,
      );
    const visibleAction =
      current &&
      ROLE_RANK[actor.role] >= ROLE_RANK[current.minRole] &&
      (!current.input || visibleSource(found, actor, current.input, privacy)) &&
      privacy.safe(current.id) &&
      privacy.safe(current.label) &&
      (currentActionLabel === undefined || privacy.safe(currentActionLabel))
        ? { id: current.id, label: current.label, kind: current.kind }
        : null;
    const visibleFlags = new Set(
      activeFlags(found, actor)
        .filter((flag) => privacy.safe(flag.label))
        .map((flag) => flag.label),
    );
    return {
      action: visibleAction,
      template:
        privacy.safe(found.ref.name) && privacy.safe(found.ref.style)
          ? { name: found.ref.name, style: found.ref.style }
          : null,
      flags: flags.filter(
        (flag) =>
          privacy.safe(flag) &&
          (visibleFlags.has(flag) || flag === 'This pass does not allow check-out.'),
      ),
    };
  } catch {
    return hidden;
  }
}

/** A refused or heads-up answer from a stop step, before any gate. */
export function stopOutcome(
  ctx: ServiceContext,
  actor: ScanActor,
  stop: Stop,
  read: CountsRead,
  options: {
    action: ResolvedScanAction | null;
    scanId?: string | null;
    card?: ScanCard | null;
    history?: unknown;
    photoUrl?: string | null;
  },
): ScanOutcome {
  const out = blankOutcome(stop.kind, read);
  const showPass = stop.pass !== null && !NO_DISPLAY.has(stop.reason);
  const details = safeOutcomeDetails(stop.found, actor, options.action, stop.flags);
  return {
    ...out,
    scanId: options.scanId ?? null,
    reason: stop.reason,
    action: details.action,
    card: showPass ? (options.card ?? null) : null,
    template: details.template,
    at: stop.at,
    flags: details.flags,
    checkIn: stop.found?.admission?.state,
    overridable:
      stop.hard !== true &&
      stop.kind === 'heads_up' &&
      details.action !== null &&
      canOverride(actor, stop.reason, options.action, read.approvals),
    display: showPass
      ? safeDisplay(ctx, actor, stop.pass, stop.kind, {
          found: stop.found ?? undefined,
          history: options.history,
          photoUrl: options.photoUrl,
        })
      : null,
  };
}

export async function undoWindowMinutes(ctx: ServiceContext): Promise<number> {
  return (await getPlatformSettings(ctx))['scan.undoWindowMinutes'];
}
