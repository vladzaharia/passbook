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
import type { CountsRead } from './counts.ts';
import { buildDisplay } from './display.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import type { Found, Stop } from './resolve.ts';
import { scanPolicy } from './rules.ts';

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

/** The display for a screen. Never throws: a render error is logged and the verdict goes out without one. */
export function safeDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  pass: { id: string; displayTitle: string | null } | null,
  screen: ScanDisplayScreen,
  more: { found?: Found; history?: unknown } = {},
): ScanDisplay | null {
  if (!pass) return null;
  try {
    return buildDisplay(ctx, {
      actor,
      pass: { id: pass.id, title: pass.displayTitle ?? '' },
      screen,
      template: more.found?.ref,
      history: more.history,
    });
  } catch (error) {
    ctx.log.error('scan.display_failed', { code: 'SCAN_DISPLAY_FAILED', screen, error });
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
    kind: reason === 'cooldown' ? 'cooldown_override' : 'let_in_again',
  });
  return verdict.allow || (verdict.why === 'needs_approval' && approvals);
}

const NO_DISPLAY = new Set<ScanReason>(['test_pass', 'live_pass']);

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
  },
): ScanOutcome {
  const out = blankOutcome(stop.kind, read);
  const showPass = stop.pass !== null && !NO_DISPLAY.has(stop.reason);
  return {
    ...out,
    scanId: options.scanId ?? null,
    reason: stop.reason,
    action: options.action
      ? { id: options.action.id, label: options.action.label, kind: options.action.kind }
      : null,
    card: showPass ? (options.card ?? null) : null,
    template: stop.ref,
    at: stop.at,
    flags: stop.flags,
    overridable:
      stop.kind === 'heads_up' && canOverride(actor, stop.reason, options.action, read.approvals),
    display: showPass
      ? safeDisplay(ctx, actor, stop.pass, stop.kind, {
          found: stop.found ?? undefined,
          history: options.history,
        })
      : null,
  };
}

export async function undoWindowMinutes(ctx: ServiceContext): Promise<number> {
  return (await getPlatformSettings(ctx))['scan.undoWindowMinutes'];
}
