import { type Cell, LADDER, type MeterId, type PricingRow, type RowGroup } from './types.ts';

/** Shorthand: true yes, false no, a number a count, null no limit. */
export type CellInput = Cell | boolean | number | null;
type Cells = readonly [CellInput, CellInput, CellInput, CellInput, CellInput, CellInput];

const cell = (v: CellInput): Cell => {
  if (v === true) return { kind: 'yes' };
  if (v === false) return { kind: 'no' };
  if (v === null) return { kind: 'unlimited' };
  if (typeof v === 'number') return { kind: 'count', value: v };
  return v;
};

/** The ROW_ICONS key for a label, as tools/build-plan-icons.ts derives it. */
export const iconKeyOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');

export const rowsOf =
  (group: string) =>
  (label: string, cells: Cells, listed = true): PricingRow => ({
    group,
    label,
    iconKey: iconKeyOf(label),
    cells: Object.fromEntries(
      LADDER.map((p, i) => [p, cell(cells[i] as CellInput)]),
    ) as PricingRow['cells'],
    listed,
  });

export const AG: Cell = { kind: 'agreed' };
export const ad = (addonId: string): Cell => ({ kind: 'addon', addonId });
export const tier = (level: number, text: string): Cell => ({ kind: 'tier', level, text });
export const days = (n: number): Cell => ({ kind: 'period', days: n });
const inc = (meter: MeterId): Cell => ({ kind: 'meter', meter, show: 'included' });
const blk = (meter: MeterId): Cell => ({ kind: 'meter', meter, show: 'block' });
const all = (c: CellInput): Cells => [c, c, c, c, c, c];
const but = (c: Cell, last: Cell): Cells => [c, c, c, c, c, last];

const GROUP_LABELS: readonly [string, string][] = [
  ['use', 'What the plan includes each month'],
  ['wallets', 'Wallets and channels'],
  ['brand', 'Identity and brand'],
  ['templates', 'Templates and pass features'],
  ['sending', 'Sending and keeping current'],
  ['data', 'Connections and commerce'],
  ['dev', 'API and developer tools'],
  ['door', 'At the door'],
  ['team', 'Team and governance'],
  ['service', 'Service'],
];

export const GROUPS_V1: readonly RowGroup[] = GROUP_LABELS.map(([id, label]) => ({
  id,
  label,
  iconKey: `area-${id}`,
}));

const use = rowsOf('use');
const wallets = rowsOf('wallets');
const brand = rowsOf('brand');
const templates = rowsOf('templates');
const T = true;
const F = false;

/** Rows whose feature has not shipped are unlisted; each package lists its rows when it ships. */
export const ROWS_V1_A: readonly PricingRow[] = [
  use('Live passes', all(inc('live_passes')), F),
  use('Extra live passes, per 100', all(blk('live_passes')), F),
  use('Passes issued a month', all(inc('passes_issued')), F),
  use(
    'Extra passes issued, per 100',
    but(blk('passes_issued'), {
      kind: 'meter',
      meter: 'passes_issued',
      show: 'block',
      about: true,
    }),
    F,
  ),
  use('Emails a month', but(inc('emails'), AG), F),
  use('Extra emails, per 1,000', but(blk('emails'), AG), F),
  use('Pass updates a month, not billed up to', all(inc('pass_updates'))),
  use('Scans a month, not billed up to', all(inc('scans'))),
  use('API calls a month, not billed up to', all(inc('api_calls'))),
  use('Webhook deliveries a month, not billed up to', all(inc('webhook_deliveries'))),
  use('Test passes', [50, 100, 250, 500, 1000, null]),
  use('Passes already sent keep working after a downgrade or missed payment', all(T), F),

  wallets('Apple Wallet', all(T)),
  wallets('Google Wallet', all(T), F),
  wallets('Samsung Wallet', [F, F, T, T, T, T], F),
  wallets('Mobile web ticket and pass page', all(T)),
  wallets('Paper tickets and print sheets', [F, T, T, T, T, T]),
  wallets('NFC tags (cards, fobs, stickers, wristbands)', [
    F,
    ad('nfc-tags-50'),
    1000,
    5000,
    20000,
    null,
  ]),
  wallets('Lent tags with a return time', [F, F, F, T, T, T]),
  wallets('Copy-proof NFC tags', [F, F, ad('copy-proof-nfc'), ad('copy-proof-nfc'), T, T], F),
  wallets("Tap with the phone's wallet", [F, F, F, ad('wallet-tap'), T, T], F),

  brand('Your logo, colours and support details', all(T)),
  brand('Shared PassBook Pass Type ID', all(T)),
  brand('Bring your own Pass Type ID', [F, F, ad('own-pass-type-id'), T, T, T]),
  brand('Managed Pass Type ID in your name', [
    F,
    F,
    ad('managed-pass-type-id'),
    ad('managed-pass-type-id'),
    3,
    AG,
  ]),
  brand('Small PassBook footer', [F, T, T, T, T, T]),
  brand('No PassBook footer', [F, F, ad('remove-footer'), T, T, T]),
  brand('Your own web address for pass pages', [F, F, F, 1, 3, null], F),
  brand('Send email from your own domain', [F, F, F, T, T, T], F),

  templates('Templates', [2, 5, 10, 100, 500, null]),
  templates('All 23 blueprints', all(T)),
  templates('Visual designer', all(T)),
  templates('Boarding pass and transit ticket style', [F, T, T, T, T, T]),
  templates('Upload your own template files', [F, F, T, T, T, T]),
  templates('Stamps, balances and packs', all(T)),
  templates('Expiry and term rules', all(T)),
  templates('Show on the lock screen near a time', all(T)),
  templates('Show on the lock screen near a place', [F, T, T, T, T, T]),
  templates('Beacons', [F, F, F, T, T, T]),
  templates('Several events or dates on one pass', all(T)),
  templates('Bundles for groups and families', [F, F, T, T, T, T]),
  templates('Photo on the pass', all(T)),
  templates('Move a pass to a new holder', all(T)),
  templates('Void and remove from the phone', all(T)),
];
