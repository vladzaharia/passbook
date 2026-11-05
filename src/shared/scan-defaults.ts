import type {
  ScanAction,
  ScanActionKind,
  ScanManifest,
  ScanRepeat,
  ScanRole,
  TemplateManifest,
} from '../passkit/types.ts';

export const DEFAULT_COOLDOWN_MINUTES = 5;

/** An action with every default applied. Defaults are read-time only and never persisted. */
export interface ResolvedScanAction extends ScanAction {
  repeat: ScanRepeat;
  minRole: ScanRole;
  confirm: boolean;
  allowAgain: boolean;
  notify: boolean;
  allowOnConnected: boolean;
}
export interface ResolvedScanManifest extends Omit<ScanManifest, 'actions'> {
  actions: ResolvedScanAction[];
}

const REPEAT: Record<ScanActionKind, ScanRepeat> = {
  check_in: 'once',
  add: 'cooldown',
  take: 'always',
  set: 'always',
  use_up: 'once',
};
const MIN_ROLE: Record<ScanActionKind, ScanRole> = {
  check_in: 'door',
  add: 'desk',
  take: 'desk',
  set: 'manager',
  use_up: 'desk',
};
const CONFIRM: Record<ScanActionKind, boolean> = {
  check_in: false,
  add: false,
  take: true,
  set: true,
  use_up: true,
};

/** No `scan` block: one check-in. */
export const DEFAULT_SCAN_ACTION: ScanAction = {
  id: 'check_in',
  label: 'Check in',
  kind: 'check_in',
};

function resolveAction(action: ScanAction): ResolvedScanAction {
  const repeat = action.repeat ?? REPEAT[action.kind];
  const resolved: ResolvedScanAction = {
    ...action,
    repeat,
    minRole: action.minRole ?? MIN_ROLE[action.kind],
    confirm: action.confirm ?? CONFIRM[action.kind],
    allowAgain: action.allowAgain ?? true,
    notify: action.notify ?? false,
    allowOnConnected: action.allowOnConnected ?? false,
  };
  if (action.kind === 'add' || action.kind === 'take') resolved.amount = action.amount ?? 1;
  if (repeat === 'cooldown') {
    resolved.cooldownMinutes = action.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  }
  return resolved;
}

/** The manifest's scan block with defaults applied (SA 4.1). */
export function scanOf(
  manifest: Pick<TemplateManifest, 'scan'> | null | undefined,
): ResolvedScanManifest {
  const scan = manifest?.scan;
  if (!scan) return { actions: [resolveAction(DEFAULT_SCAN_ACTION)] };
  return { ...scan, actions: scan.actions.map(resolveAction) };
}

/** Whether the ready action can be armed so the next scans apply it, and how long it stays armed. */
export function armable(action: ResolvedScanAction): 'sticky' | 'once' | null {
  if (action.kind === 'check_in') return 'sticky';
  if (action.kind !== 'add') return null;
  const fixed = typeof action.amount === 'number';
  return fixed && !action.confirm ? 'sticky' : 'once';
}
