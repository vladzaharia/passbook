// Test-mode waiver (billing plan AD5). A feature whose objects carry a mode is free in Test, so a team can
// try it before paying; org-wide features and every count are not. Classified by name, so a key a later
// package adds is already decided; a test fails on any registry key in neither list.
// A route waives only when it opts in (`feature: { key, testWaived: true }`) and only for a Test principal.
// No row, no waiver. Anything that moves a Test object to Live (scanner Go live, template promote) re-checks
// every waived key the object uses against the Live plan and refuses with FEATURE_NOT_INCLUDED.
import type { Mode } from '../common.ts';
import type { EntitlementValue } from './kinds.ts';
import { ENTITLEMENT_KEYS, type EntitlementKey, entitlementDef } from './registry.ts';

/** Flags, levels and lists that pass in Test. Never a limit. */
export const TEST_WAIVABLE: readonly string[] = [
  'print',
  'scanning.desk',
  'scanning.rules',
  'scanning.approvals',
  'scanning.display',
  'scanning.displayCustom',
  'scanning.selfCheckIn',
  'scanning.kioskWalkIn',
  'messages.scheduled',
  'passes.locations',
  'passes.beacons',
  'templates.stylesBlocked',
  'bundles',
];

/**
 * Org-wide features, billing state and every count: the same in Test as in Live. `templates.uploads` is
 * here because an upload makes an org-wide template that releases to Live; `connectors` because a
 * connection has no mode; NFC because a tag write is not yet checked per mode (E7).
 */
export const NOT_TEST_WAIVABLE: readonly string[] = [
  'connectors',
  'nfc',
  'nfc.lending',
  'nfc.wallet',
  'templates.uploads',
  'api',
  'api.rateTier',
  'api.orgRate',
  'api.keys',
  'api.ipAllow',
  'apps',
  'webhooks',
  'webhooks.endpoints',
  'connections',
  'wallet.google',
  'wallet.samsung',
  'nfc.tags',
  'scanning.devices',
  'scanning.staff',
  'scanning.zones',
  'scans.retentionDays',
  'join.perDay',
  'messages.perDay',
  'messages.rules',
  'passes.changesPerDay',
  'passes.live',
  'passes.issuedPerMonth',
  'passes.issuePaused',
  'passes.test',
  'email.perMonth',
  'email.perDay',
  'templates',
  'members',
  'members.developers',
  'roles.advanced',
  'brand.mark',
  'identity.own',
  'identity.managed',
  'audit.retentionDays',
  'audit.export',
  'reports.full',
  'org.restricted',
  'domains',
  'email.ownDomain',
  'members.sync',
  'account.orgs',
  'account.orgApi',
  'account.staging',
];

const WAIVABLE = new Set(TEST_WAIVABLE);

export const isTestWaivable = (key: string): boolean => WAIVABLE.has(key);

/** The registry keys a Test principal gets in full. */
export const WAIVED_KEYS: readonly EntitlementKey[] = ENTITLEMENT_KEYS.filter(
  (key) => isTestWaivable(key) && entitlementDef(key).kind !== 'limit',
);

/** The most a waived key can be: a flag on, the highest level, every item allowed, nothing blocked. */
function fullValue(key: EntitlementKey): EntitlementValue {
  const def = entitlementDef(key);
  switch (def.kind) {
    case 'flag':
      return 1;
    case 'level':
      return def.levels[def.levels.length - 1] ?? '';
    case 'list':
      return def.block ? [] : ['*'];
    case 'limit':
      throw new Error(`${key} is a limit; a limit is never waived`);
  }
}

/**
 * The org's values as a principal in `mode` sees them: Live unchanged, Test with every waived key the org
 * has a row for full. A key with no row stays missing, so it still refuses.
 */
export function valuesInMode<T extends Partial<Record<EntitlementKey, EntitlementValue>>>(
  values: T,
  mode: Mode,
): T {
  if (mode !== 'test') return values;
  const waived = WAIVED_KEYS.filter((key) => values[key] !== undefined);
  return { ...values, ...Object.fromEntries(waived.map((key) => [key, fullValue(key)])) };
}
