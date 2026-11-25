import type { EntitlementKey } from '../contracts/entitlements.ts';
import type { FooterLevel, NfcLevel } from '../plan-facts.ts';
import { passbookCredit } from './passbook-credit.ts';

/** The plan picker's words. Facts come from the plan's values (`planFacts`); there is no prose per plan. */
export const PLAN_COPY = {
  title: 'Plan',
  compare: 'Compare',
  compareTitle: 'Compare plans',
  apply: 'Apply plan',
  current: 'Current',
  noLimit: 'No limit',
  none: 'None',
  footer: 'Footer',
  limits: 'Limits',
  features: 'Features',
  placesTitle: 'Where PassBook shows',
  placesNote: 'The org picks its footer in Brand, within what its plan allows.',
  insteadOf: (target: string, current: string) => `${target} instead of ${current}`,
  applyTarget: (target: string) => `Apply ${target}`,
  updated: (when: string) => `Updated ${when}`,
} as const;

export const CHANNEL_CHIP = {
  apple: 'Apple',
  google: 'Google',
  samsung: 'Samsung',
  print: 'Paper',
  nfc: { off: 'NFC', basic: 'NFC tags', secure: 'Copy-proof NFC' } satisfies Record<
    NfcLevel,
    string
  >,
} as const;

/** The footer as a holder reads it, by the smallest level a plan allows. `none` has no footer to quote. */
const credit = (level: FooterLevel): string => {
  const c = passbookCredit(level === 'quiet' ? 'small' : level === 'full' ? 'full' : 'none');
  return c ? `${c.lead} ${c.name}`.trim() : 'Nothing';
};
export const FOOTER_SAMPLE: Record<FooterLevel, string> = {
  full: credit('full'),
  quiet: credit('quiet'),
  none: PLAN_COPY.none,
};

/** Where PassBook shows, per footer level (the "info" popover). */
export const PLAN_PLACES: ReadonlyArray<{
  place: string;
  hint?: string;
  by: Record<FooterLevel, string>;
}> = [
  { place: 'Wallet passes', by: { full: 'Never', quiet: 'Never', none: 'Never' } },
  {
    place: 'Pass pages',
    hint: 'Pass, barcode, bundle, join, tag, print',
    by: { full: `${credit('full')} and logo`, quiet: credit('quiet'), none: 'Nothing' },
  },
  { place: 'Emails', by: { full: credit('full'), quiet: credit('quiet'), none: 'Nothing' } },
  {
    place: 'Email sender',
    by: { full: '{Org} via PassBook', quiet: '{Org} via PassBook', none: '{Org} via PassBook' },
  },
  { place: 'Print sheets', by: { full: credit('full'), quiet: credit('quiet'), none: 'Nothing' } },
  { place: 'Scanner screen', by: { full: 'Never', quiet: 'Never', none: 'Never' } },
];

export type CompareKind = 'limit' | 'flag' | 'nfc' | 'connectors' | 'footer';
export interface CompareRow {
  key: EntitlementKey;
  label: string;
  kind: CompareKind;
}

/** Compare plans: the features that differ between plans and that something enforces, grouped. */
export const COMPARE_ROWS: ReadonlyArray<{ group: string; rows: readonly CompareRow[] }> = [
  {
    group: 'Passes',
    rows: [
      { key: 'passes.live', label: 'Live passes', kind: 'limit' },
      { key: 'passes.test', label: 'Test passes', kind: 'limit' },
      { key: 'templates', label: 'Templates', kind: 'limit' },
      { key: 'templates.uploads', label: 'Template uploads', kind: 'flag' },
    ],
  },
  {
    group: 'Channels',
    rows: [
      { key: 'wallet.google', label: 'Google Wallet', kind: 'flag' },
      { key: 'wallet.samsung', label: 'Samsung Wallet', kind: 'flag' },
      { key: 'print', label: 'Print at home', kind: 'flag' },
      { key: 'nfc', label: 'NFC tags', kind: 'nfc' },
    ],
  },
  { group: 'Door', rows: [{ key: 'scanning.devices', label: 'Scanners', kind: 'limit' }] },
  {
    group: 'Sending',
    rows: [
      { key: 'email.perDay', label: 'Emails per day', kind: 'limit' },
      { key: 'messages.perDay', label: 'Broadcasts per day', kind: 'limit' },
      { key: 'passes.changesPerDay', label: 'Change runs per day', kind: 'limit' },
      { key: 'join.perDay', label: 'Join passes per day', kind: 'limit' },
    ],
  },
  {
    group: 'Integrations',
    rows: [
      { key: 'api.keys', label: 'API keys', kind: 'limit' },
      { key: 'webhooks', label: 'Webhooks', kind: 'flag' },
      { key: 'webhooks.endpoints', label: 'Webhook endpoints', kind: 'limit' },
      { key: 'connections', label: 'Connections', kind: 'limit' },
      { key: 'connectors', label: 'Connectors', kind: 'connectors' },
    ],
  },
  {
    group: 'Team',
    rows: [
      { key: 'members', label: 'Members', kind: 'limit' },
      { key: 'members.developers', label: 'Developers', kind: 'limit' },
    ],
  },
  {
    group: 'Identity',
    rows: [{ key: 'identity.managed', label: 'Managed Pass Type ID', kind: 'flag' }],
  },
  { group: 'Branding', rows: [{ key: 'brand.mark', label: 'PassBook footer', kind: 'footer' }] },
];

/** Keys Compare leaves out, with why. Every registry key is here or in COMPARE_ROWS (a test holds it). */
export const NOT_COMPARED: Partial<Record<EntitlementKey, string>> = {
  api: 'same on every plan',
  'api.rateTier': 'not enforced',
  apps: 'not built',
  'templates.stylesBlocked': 'not enforced',
  domains: 'not built',
  'identity.own': 'not enforced',
};

export const CONNECTORS_ALL = 'All';
export const CONNECTORS_BASIC = 'CSV, webhook push and demo';
