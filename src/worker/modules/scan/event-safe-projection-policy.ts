import type { ScanActionKind, ScanRole } from '../../../passkit/types.ts';
import { type ResolvedScanAction, scanOf } from '../../../shared/scan-defaults.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

export const ACTION_KINDS: readonly ScanActionKind[] = ['check_in', 'add', 'take', 'set', 'use_up'];
/** Source policy only needs the role. Do not simulate an admin, staff member or privileged session. */
export function sourceActor(actor: ScanActor, role: ScanRole): ScanActor {
  return {
    principal: 'scanner',
    orgId: actor.orgId,
    mode: actor.mode,
    actorKey: '',
    actor: { type: 'scanner', id: '' },
    scanner: null,
    event: null,
    templateIds: [],
    timeZone: DEFAULT_TIME_ZONE,
    role,
    staff: null,
    settings: {
      ...actor.settings,
      roleWithoutSignIn: 'door',
      staffSignIn: false,
      lookup: false,
      letInAgain: 'never',
    },
    name: '',
    terminal: true,
  };
}

/** Resolve all action policies independently, including incompatible active revisions. */
export function actionPolicies(
  found: Found,
  requested: ResolvedScanAction | null,
): ResolvedScanAction[] | null {
  if (
    !requested ||
    typeof requested.id !== 'string' ||
    !requested.id ||
    typeof requested.label !== 'string' ||
    !requested.label ||
    !ACTION_KINDS.includes(requested.kind)
  )
    return null;
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  const groups = [
    found.scan.actions,
    scanOf(found.template.manifest).actions,
    scanOf(active.manifest).actions,
  ];
  const matches = groups.map((actions) => actions.filter((action) => action.id === requested.id));
  if (matches.some((actions) => actions.length !== 1)) return null;
  const actions = matches.map((items) => {
    const item = items[0];
    if (item === undefined) throw new Error('Missing matched action');
    return item;
  });
  const evaluated = actions[0];
  const pinned = actions[1];
  if (evaluated === undefined || pinned === undefined) throw new Error('Missing action policy');
  if (
    actions.some(
      (action) =>
        action.kind !== requested.kind ||
        action.input !== requested.input ||
        typeof action.label !== 'string' ||
        !action.label ||
        !Object.hasOwn(ROLE_RANK, action.minRole),
    ) ||
    evaluated.label !== requested.label ||
    pinned.label !== requested.label ||
    requested.minRole !== evaluated.minRole ||
    !Object.hasOwn(ROLE_RANK, requested.minRole) ||
    (requested.input !== undefined && (typeof requested.input !== 'string' || !requested.input))
  )
    return null;
  return actions;
}
