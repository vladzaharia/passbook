import type { Addon, AddonGrant, AddonKind, PlanId } from './types.ts';

const at = (priceMinor: number, ...plans: PlanId[]): Addon['plans'] =>
  Object.fromEntries(plans.map((p) => [p, { priceMinor }]));

const UP: PlanId[] = ['starter', 'standard', 'business', 'premium'];
const SEASON_UP: PlanId[] = ['standard', 'business', 'premium'];

interface Spec {
  id: string;
  name: string;
  kind: AddonKind;
  grant: AddonGrant | null;
  iconKey: string;
  plans: Addon['plans'];
  sellable?: boolean;
  listed?: boolean;
  perUnit?: boolean;
}

const addon = (s: Spec): Addon => ({
  discountable: true,
  sellable: true,
  listed: true,
  perUnit: false,
  ...s,
});

const pack =
  (id: string, name: string, key: string, add: number, iconKey: string) =>
  (plans: Addon['plans']): Addon =>
    addon({ id, name, kind: 'pack', grant: { key, add }, iconKey, plans });

/** Add-ons in catalog version 1 (42-gating-final.md and 10-plan.md §10). Enterprise gets them by quote. */
export const ADDONS_V1: readonly Addon[] = [
  pack(
    'scanners-5',
    '5 more scanners',
    'scanning.devices',
    5,
    'scanners',
  )(at(2500, 'starter', 'standard')),
  pack(
    'scanners-50',
    '50 more scanners',
    'scanning.devices',
    50,
    'scanners',
  )(at(2500, 'business', 'premium')),
  pack(
    'staff-25',
    '25 more door staff',
    'scanning.staff',
    25,
    'door-staff-with-pins',
  )(at(1000, ...UP)),
  pack('members-5', '5 more team members', 'members', 5, 'team-members')(at(3500, ...UP)),
  pack(
    'developer-seat',
    'Another developer seat',
    'members.developers',
    1,
    'developer-seats',
  )(at(1500, ...SEASON_UP)),
  pack(
    'templates-5',
    '5 more templates',
    'templates',
    5,
    'templates',
  )(at(1000, 'starter', 'standard')),
  pack(
    'templates-50',
    '50 more templates',
    'templates',
    50,
    'templates',
  )(at(1000, 'business', 'premium')),
  pack('connection', 'Another connection', 'connections', 1, 'connections')(at(1500, ...UP)),
  pack(
    'webhook-endpoints-5',
    '5 more webhook endpoints',
    'webhooks.endpoints',
    5,
    'webhook-endpoints',
  )(at(1000, ...UP)),
  pack('zones-5', '5 more zones or gates', 'scanning.zones', 5, 'zones-and-gates')(at(1000, ...UP)),
  pack(
    'nfc-tags-50',
    '50 NFC tags',
    'nfc.tags',
    50,
    'nfc-tags-cards-fobs-stickers-wristbands',
  )(at(500, 'starter')),
  pack(
    'nfc-tags-1000',
    '1,000 more NFC tags',
    'nfc.tags',
    1000,
    'nfc-tags-cards-fobs-stickers-wristbands',
  )(at(2500, ...SEASON_UP)),
  addon({
    id: 'audit-7y',
    name: 'Audit log kept 7 years',
    kind: 'feature',
    grant: { key: 'audit.retentionDays', set: 2555 },
    iconKey: 'audit-log',
    plans: at(9900, 'business', 'premium'),
  }),
  addon({
    id: 'own-pass-type-id',
    name: 'Your own Pass Type ID',
    kind: 'feature',
    grant: { key: 'identity.own', set: 1 },
    iconKey: 'bring-your-own-pass-type-id',
    plans: at(1900, 'standard'),
  }),
  addon({
    id: 'managed-pass-type-id',
    name: 'Managed Pass Type ID',
    kind: 'feature',
    grant: { key: 'identity.managed', add: 1 },
    iconKey: 'managed-pass-type-id-in-your-name',
    plans: at(2900, ...SEASON_UP),
    perUnit: true,
  }),
  addon({
    id: 'remove-footer',
    name: 'Remove the PassBook footer',
    kind: 'feature',
    grant: { key: 'brand.mark', set: 'none' },
    iconKey: 'no-passbook-footer',
    plans: at(2900, 'standard'),
  }),
  addon({
    id: 'capacity-rules',
    name: 'Entry rules: capacity and auto tap-out',
    kind: 'feature',
    grant: { key: 'scanning.rules', set: 'capacity' },
    iconKey: 'entry-rules-capacity-and-auto-tap-out',
    plans: at(1900, 'standard'),
  }),
  addon({
    id: 'advanced-roles',
    name: 'Author, reviewer, publisher and integration roles',
    kind: 'feature',
    grant: { key: 'roles.advanced', set: 1 },
    iconKey: 'author-reviewer-publisher-and-integration-roles',
    plans: at(1900, 'standard'),
  }),
  addon({
    id: 'copy-proof-nfc',
    name: 'Copy-proof NFC tags',
    kind: 'feature',
    grant: { key: 'nfc', set: 'secure' },
    iconKey: 'copy-proof-nfc-tags',
    plans: at(9900, 'standard', 'business'),
    sellable: false,
  }),
  addon({
    id: 'wallet-tap',
    name: "Tap with the phone's wallet",
    kind: 'feature',
    grant: { key: 'nfc.wallet', set: 1 },
    iconKey: 'tap-with-the-phone-s-wallet',
    plans: at(9900, 'business'),
    sellable: false,
  }),
  addon({
    id: 'priority-support',
    name: 'Priority support',
    kind: 'feature',
    grant: null,
    iconKey: 'priority-support',
    plans: at(4900, 'standard', 'business'),
    sellable: false,
  }),
  addon({
    id: 'team-sync',
    name: 'Add and remove team members automatically',
    kind: 'feature',
    grant: { key: 'members.sync', set: 1 },
    iconKey: 'add-and-remove-team-members-automatically',
    plans: at(4900, ...SEASON_UP),
    sellable: false,
  }),
  addon({
    id: 'extra-org',
    name: 'Another organization on the bill',
    kind: 'feature',
    grant: { key: 'account.orgs', add: 1 },
    iconKey: 'organizations-on-one-bill-sharing-the-allowance',
    plans: at(2000, 'business', 'premium'),
    sellable: false,
  }),
  addon({
    id: 'staging-org',
    name: 'A staging organization',
    kind: 'feature',
    grant: { key: 'account.staging', set: 1 },
    iconKey: 'a-staging-organization',
    plans: at(2000, 'business'),
    sellable: false,
  }),
  addon({
    id: 'web-address',
    name: 'Another web address',
    kind: 'feature',
    grant: { key: 'domains', add: 1 },
    iconKey: 'your-own-web-address-for-pass-pages',
    plans: at(1500, 'business', 'premium'),
    sellable: false,
  }),
  addon({
    id: 'locations-10',
    name: '10 more locations',
    kind: 'pack',
    grant: null,
    iconKey: 'locations-with-their-own-staff-and-counts',
    plans: at(3500, ...SEASON_UP),
    sellable: false,
    listed: false,
  }),
];
