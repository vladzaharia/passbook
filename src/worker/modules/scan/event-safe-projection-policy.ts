import type { ScanActionKind, ScanRole } from '../../../passkit/types.ts';
import { type ResolvedScanAction, scanOf } from '../../../shared/scan-defaults.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

export const ACTION_KINDS: readonly ScanActionKind[] = ['check_in', 'add', 'take', 'set', 'use_up'];
export const PUBLIC_WALLET_ROOT: Record<string, true> = {
  formatVersion: true,
  organizationName: true,
  description: true,
  logoText: true,
  eventLogoText: true,
  foregroundColor: true,
  backgroundColor: true,
  labelColor: true,
  stripColor: true,
  footerBackgroundColor: true,
  useAutomaticColors: true,
  suppressHeaderDarkening: true,
  suppressStripShine: true,
  sharingProhibited: true,
};
export const WALLET_STYLES: Record<string, true> = {
  generic: true,
  posterGeneric: true,
  storeCard: true,
  coupon: true,
  eventTicket: true,
  boardingPass: true,
};
const WALLET_FIELD_GROUPS: Record<string, true> = {
  headerFields: true,
  primaryFields: true,
  secondaryFields: true,
  auxiliaryFields: true,
  backFields: true,
  additionalInfoFields: true,
  footerFields: true,
};
const WALLET_FIELD_PROPERTIES: Record<string, true> = {
  key: true,
  value: true,
  label: true,
  attributedValue: true,
  changeMessage: true,
  currencyCode: true,
  numberStyle: true,
  dateStyle: true,
  timeStyle: true,
  textAlignment: true,
  isRelative: true,
  ignoresTimeZone: true,
  row: true,
};

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
    timeZone: 'UTC',
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

/** Remember complete and escaped spellings without ever projecting their source objects. */
export function appendProtected(value: unknown, values: string[]): void {
  if (typeof value === 'string' && value) {
    values.push(value);
    if (/[&<>"']/.test(value))
      values.push(
        value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;'),
      );
    if (/[^A-Za-z0-9_.!~*'()-]/.test(value)) values.push(encodeURIComponent(value.toWellFormed()));
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    values.push(String(value));
  } else if (Array.isArray(value)) {
    value.forEach((item) => {
      appendProtected(item, values);
    });
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => {
      appendProtected(item, values);
    });
  }
}

const FIELD_LABELS = new Set(['label', 'attributedLabel']);

/** Like appendProtected, but without field labels, which come from the template and not the holder. */
export function appendFieldValues(value: unknown, values: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      appendFieldValues(item, values);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      if (!FIELD_LABELS.has(key)) appendFieldValues(item, values);
  } else appendProtected(value, values);
}

/** Preserve ordinary display fields; unknown Wallet metadata is never an authorized source. */
export function appendOpaqueStyle(value: unknown, values: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    appendProtected(value, values);
    return;
  }
  for (const [group, fields] of Object.entries(value)) {
    if (group === 'transitType') continue;
    if (!Object.hasOwn(WALLET_FIELD_GROUPS, group) || !Array.isArray(fields)) {
      appendProtected(fields, values);
      continue;
    }
    for (const field of fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        appendProtected(field, values);
        continue;
      }
      for (const [name, part] of Object.entries(field))
        if (!Object.hasOwn(WALLET_FIELD_PROPERTIES, name)) appendProtected(part, values);
    }
  }
}

export function containsProtected(value: string, values: readonly string[]): boolean {
  return values.some((secret) => (secret.length < 3 ? value === secret : value.includes(secret)));
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
