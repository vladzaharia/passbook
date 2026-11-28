import type { z } from 'zod';
import type { ScanCheckIn } from '../passkit/template/scan-check-in.ts';
import type {
  ScanAction,
  ScanActionKind,
  ScanManifest,
  ScanRepeat,
  ScanRole,
  TemplateManifest,
} from '../passkit/types.ts';
import type { MonitorAudience, ScanAppearance, ScannerSettings } from './contracts/scan.ts';
import type { DeviceRoleSchema } from './contracts/scanners.ts';

export const DEFAULT_COOLDOWN_MINUTES = 5;

type DeviceRole = z.infer<typeof DeviceRoleSchema>;
type ScanAppearance = NonNullable<ScannerSettings['appearance']>;
type MonitorAudience = NonNullable<ScannerSettings['monitorAudience']>;

/** The theme a role follows when `appearance` is absent. */
export const DEFAULT_APPEARANCE: Record<DeviceRole, ScanAppearance> = {
  scan: 'system',
  customer: 'light',
  monitor: 'light',
  kiosk: 'light',
};
export const DEFAULT_MONITOR_AUDIENCE: MonitorAudience = 'public';

export function appearanceOf(
  role: DeviceRole,
  settings: Pick<ScannerSettings, 'appearance'> | null | undefined,
): ScanAppearance {
  return settings?.appearance ?? DEFAULT_APPEARANCE[role];
}

/** Only an explicit `staff` opens names and reasons. Anything else, absent included, is `public`. */
export function audienceOf(
  settings: Pick<ScannerSettings, 'monitorAudience'> | null | undefined,
): MonitorAudience {
  return settings?.monitorAudience === 'staff' ? 'staff' : DEFAULT_MONITOR_AUDIENCE;
}

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

const CHECK_IN_REPEAT: Record<NonNullable<ScanCheckIn['mode']>, ScanRepeat> = {
  single: 'once',
  daily: 'daily',
  unlimited: 'always',
};

function resolveAction(
  action: ScanAction,
  access: boolean,
  stamps?: { input: string; goal: number },
  mode?: ScanCheckIn['mode'],
): ResolvedScanAction {
  // An access template lets a member in on every visit: no once, no daily, no already_done.
  // The pass type's own check-in mode sits between the action's repeat and the kind's default.
  const repeat =
    access && action.kind === 'check_in'
      ? 'always'
      : (action.repeat ??
        (action.kind === 'check_in' && mode ? CHECK_IN_REPEAT[mode] : REPEAT[action.kind]));
  const resolved: ResolvedScanAction = {
    ...action,
    repeat,
    minRole: action.minRole ?? MIN_ROLE[action.kind],
    confirm: action.confirm ?? CONFIRM[action.kind],
    allowAgain: action.allowAgain ?? true,
    notify: action.notify ?? false,
    allowOnConnected: action.allowOnConnected ?? false,
  };
  // A stamp card's reward takes its goal, unless the template names another amount.
  const goal = stamps && action.kind === 'take' && stamps.input === action.input ? stamps.goal : 1;
  if (action.kind === 'add' || action.kind === 'take') resolved.amount = action.amount ?? goal;
  if (repeat === 'cooldown') {
    resolved.cooldownMinutes = action.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  }
  return resolved;
}

/** The manifest's scan block with defaults applied (SA 4.1). */
export function scanOf(
  manifest: Pick<TemplateManifest, 'scan' | 'stamps'> | null | undefined,
): ResolvedScanManifest {
  const scan = manifest?.scan;
  if (!scan) return { actions: [resolveAction(DEFAULT_SCAN_ACTION, false)] };
  const stamps = manifest?.stamps;
  return {
    ...scan,
    actions: scan.actions.map((a) =>
      resolveAction(a, scan.access !== undefined, stamps, scan.checkIn?.mode),
    ),
  };
}

/** Whether the ready action can be armed so the next scans apply it, and how long it stays armed. */
export function armable(action: ResolvedScanAction): 'sticky' | 'once' | null {
  if (action.kind === 'check_in') return 'sticky';
  if (action.kind !== 'add') return null;
  const fixed = typeof action.amount === 'number';
  return fixed && !action.confirm ? 'sticky' : 'once';
}
