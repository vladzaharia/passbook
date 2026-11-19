import { roleAtLeast } from '@/passkit/template/scan-display/scope.ts';
import type { ScanAction, ScanRole } from '@/passkit/types.ts';
import type { ScanCard } from '@/shared/contracts/scan.ts';
import type { ScanDisplay } from '@/shared/contracts/scan-display.ts';
import type { ScanOutcome } from '@/web/scan/machine/types.ts';
import type { Dict } from '../model.ts';
import type { PreviewTab } from './scan-stage-types.ts';

const ID = '01900000-0000-7000-8000-000000000001';
const MINUTE = 60_000;

function cardOf(
  rendered: ScanDisplay,
  actions: ScanAction[],
  role: ScanRole,
  template: { name: string; style: string },
  passJson: Dict,
): ScanCard {
  return {
    passId: ID,
    version: 1,
    mode: 'test',
    title: rendered.identity.holder,
    subtitle: rendered.header.meta,
    template: { id: ID, ...template },
    status: 'active',
    validFrom: null,
    validUntil: null,
    flags: [],
    values: [],
    actions: actions.map((action) => {
      const allowed = roleAtLeast(role, action.minRole);
      return {
        id: action.id,
        label: action.label,
        kind: action.kind,
        available: allowed,
        lock: allowed ? null : 'role',
        reason: null,
        amount: typeof action.amount === 'number' ? { fixed: action.amount } : null,
        confirm: false,
        confirmAbove: null,
        cooldownRemainingMs: null,
        armable: null,
        rewardLabel: null,
      };
    }),
    display: rendered,
    access: null,
    lastScans: [],
    bundle: null,
    door: null,
    passView: { passJson: passJson as never, assetBaseUrl: '', assetGrant: '', assetNames: [] },
  };
}

/**
 * The outcome the scanner would hold for this tab: the rendered display on the verdict a real
 * scan of this pass would give. Only the system facts around it (scan id, counts, who scanned
 * before) are simulated.
 */
export function previewOutcome({
  rendered,
  tab,
  actions,
  role,
  template,
  passJson,
  now,
}: {
  rendered: ScanDisplay;
  tab: PreviewTab;
  actions: ScanAction[];
  role: ScanRole;
  template: { name: string; style: string };
  passJson: Dict;
  now: number;
}): ScanOutcome {
  const screen = tab.screen;
  const action = tab.action ?? actions[0] ?? null;
  const base: ScanOutcome = {
    scanId: ID,
    kind: screen,
    reason: null,
    replay: false,
    action: null,
    card: null,
    previous: null,
    template,
    at: now,
    cooldownRemainingMs: null,
    value: null,
    flags: [],
    overridable: false,
    approvals: true,
    group: null,
    counts: { today: 42, event: null, asOf: now, configRev: 1 },
    milestone: null,
    undoUntil: null,
    access: null,
    display: rendered,
  };
  if (screen === 'ready')
    return {
      ...base,
      scanId: null,
      reason: 'choose',
      card: cardOf(rendered, actions, role, template, passJson),
    };
  if (screen === 'heads_up')
    return {
      ...base,
      reason: 'already_done',
      action: action && { id: action.id, label: action.label, kind: action.kind },
      previous: {
        scanId: ID,
        at: now - 12 * MINUTE,
        scannerName: 'Sample scanner',
        staffName: null,
        actionLabel: action?.label ?? 'Check in',
        override: false,
      },
      overridable: true,
    };
  if (screen === 'refused') return { ...base, reason: 'voided' };
  return {
    ...base,
    action: action && { id: action.id, label: action.label, kind: action.kind },
    undoUntil: now + 30_000,
  };
}
