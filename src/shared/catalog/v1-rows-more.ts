import type { Cell, PricingRow } from './types.ts';
import { AG, ad, days, rowsOf, tier } from './v1-rows.ts';

const sending = rowsOf('sending');
const data = rowsOf('data');
const dev = rowsOf('dev');
const door = rowsOf('door');
const team = rowsOf('team');
const service = rowsOf('service');
const T = true;
const F = false;
const preset = tier(1, 'Presets');
const overview = tier(1, 'Overview');
const dpa = tier(1, 'Standard');
const negotiated: Cell = { kind: 'agreed', text: 'Negotiated' };
const year = days(365);

export const ROWS_V1_B: readonly PricingRow[] = [
  sending('Push updates to passes', [T, T, T, T, T, T]),
  sending('Join links and QR sign-up, per day', [10, 150, 1500, 3000, 7500, null]),
  sending('Broadcasts per day', [1, 5, 10, 25, 50, AG]),
  sending('Scheduled broadcasts', [F, T, T, T, T, T]),
  sending('Automatic reminders (active rules)', [F, 3, 10, 25, 50, null]),
  sending('Bulk changes per day', [1, 3, 8, 20, 50, AG]),

  data('Connections', [1, 2, 3, 15, 40, null]),
  data('Spreadsheet link and file upload', [T, T, T, T, T, T]),
  data('Receive events from any tool (webhook)', [F, T, T, T, T, T]),
  data('Shop and payment presets: Shopify, WooCommerce, Stripe', [F, T, T, T, T, T]),
  data('Booking and ticketing presets: Cal.com, Ticket Tailor', [F, T, T, T, T, T]),
  data("Read from another tool's API", [F, T, T, T, T, T]),
  data('Zapier', [F, T, T, T, T, T], F),
  data('Ready-made apps: Shopify app, Square, Eventbrite', [F, F, T, T, T, T], F),
  data('Import passes from a sheet', [T, T, T, T, T, T]),
  data('Export your data', [T, T, T, T, T, T]),

  dev('Full API', [T, T, T, T, T, T]),
  dev('Test mode, Workbench and request logs', [T, T, T, T, T, T]),
  dev('SDKs and command line tool', [T, T, T, T, T, T], F),
  dev('API keys', [2, 2, 5, 12, 30, null]),
  dev('Webhook endpoints', [1, 2, 4, 15, 40, null]),
  dev('API requests per minute, per key', [60, 120, 600, 3000, 6000, 12000]),
  dev('API requests per minute, whole organization', [120, 240, 1200, 6000, 12000, AG], F),
  dev('Restrict a key to IP addresses', [F, F, F, T, T, T]),
  dev('Developer seats', [1, 2, 3, 8, 25, null]),
  dev('A staging organization', [F, F, F, ad('staging-org'), T, T], F),

  door('Scanners', [1, 5, 10, 50, 100, null]),
  door('Scan in a browser or the iPhone and Android apps', [T, T, T, T, T, T]),
  door('Keep scanning without a connection', [T, T, T, T, T, T]),
  door('Hardware barcode scanners', [F, T, T, T, T, T]),
  door('Find someone by name', [T, T, T, T, T, T]),
  door('Door staff with PINs', [1, 10, 30, 500, 2000, null]),
  door("Live counts, who's in and roll call", [T, T, T, T, T, T]),
  door('Entry rules: cooldown, re-entry, in and out', [F, T, T, T, T, T]),
  door('Entry rules: capacity and auto tap-out', [F, F, ad('capacity-rules'), T, T, T]),
  door('Desk console', [F, F, T, T, T, T]),
  door('Customer-facing screen', [F, F, T, T, T, T]),
  door('Zones and gates', [1, 3, 5, 25, 100, null]),
  door('Design what staff see for each pass', [preset, preset, preset, T, T, T]),
  door('Manager approval and overrides', [F, F, T, T, T, T]),
  door('Scan history kept', [
    days(30),
    days(60),
    days(183),
    days(396),
    days(730),
    { kind: 'period', days: 1095, orAgreed: true },
  ]),
  door('Export scan history', [T, T, T, T, T, T]),

  team('Team members', [2, 5, 8, 40, 250, null]),
  team('Admin, operator and read-only roles', [T, T, T, T, T, T]),
  team('Author, reviewer, publisher and integration roles', [F, F, ad('advanced-roles'), T, T, T]),
  team('Locations with their own staff and counts', [F, F, 3, 10, 40, null], F),
  team("Sign in with your company's identity provider", [T, T, T, T, T, T], F),
  team(
    'Add and remove team members automatically',
    [F, F, ad('team-sync'), ad('team-sync'), ad('team-sync'), T],
    F,
  ),
  team('Audit log', [year, year, year, days(730), days(1095), days(2555)]),
  team('Export the audit log', [F, F, F, T, T, T]),
  team('Activity reports', [overview, overview, overview, T, T, T]),
  team(
    'Organizations on one bill, sharing the allowance',
    [1, 1, 1, 3, 10, { kind: 'unlimited', text: 'No limit, no fee each' }],
    F,
  ),
  team('Create organizations by API, with usage per organization', [F, F, F, F, F, T], F),

  service(
    'Support',
    [
      tier(1, 'Docs'),
      tier(2, 'Email'),
      tier(3, 'Email, 2 days'),
      tier(4, 'Email, 1 day'),
      tier(5, 'Priority'),
      tier(6, 'Named contact'),
    ],
    F,
  ),
  service('Priority support', [F, F, ad('priority-support'), ad('priority-support'), T, T], F),
  service('Uptime commitment', [F, F, F, F, F, T], F),
  service('Data processing agreement', [dpa, dpa, dpa, dpa, dpa, negotiated], F),
  service(
    '25% off for nonprofits, member-run clubs, schools and public bodies',
    [F, T, T, T, T, negotiated],
    F,
  ),
];
