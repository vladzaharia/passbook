// Names for the entities in the example world: one table per kind of entity, several realistic values each.
// A name is picked by the entity the field sits in (read from its path), never by a default: a field whose
// entity has no table makes the generator fail, so a new kind of entity has to get its own names.
import { hex, ORG } from './example-world.ts';

export const TABLES: Record<string, string[]> = {
  org: [ORG],
  person: ['Sam Rivera', 'Priya Nair', 'Marcus Webb', 'Lena Fischer', 'Tomas Ortega'],
  visitor: ['Jordan Lee', 'Maya Patel', 'Chris Dalton', 'Noor Haddad'],
  holder: ['Ada Example', 'Grace Okafor', 'Alan Reyes', 'Mei Tanaka'],
  template: ['Day pass', 'Ten-visit card', 'Monthly membership', 'Youth session pass'],
  pass: ['Day pass', 'Ten-visit card', 'Monthly membership'],
  event: ['Open climbing', 'Youth night', 'Bouldering league', 'Route-setting day'],
  zone: ['Main hall', 'Bouldering cave', 'Training room', 'Rooftop terrace'],
  place: ['Front entrance', 'Locker room', 'Cafe', 'Gear shop'],
  bundle: ['Family pack', 'Birthday party', 'School group', 'Team outing'],
  view: ['Expiring soon', 'Day passes this week', 'Not yet installed', 'Staff and coaches'],
  asset: ['logo.png', 'icon.png', 'strip.png', 'thumbnail.png'],
  file: ['members.csv', 'spring-members.csv', 'guest-list.csv', 'tags.csv'],
  hour: ['9 AM', '10 AM', '5 PM', '6 PM', '7 PM'],
  action: ['Admit', 'Check out', 'Add a visit', 'Redeem reward'],
  inputLabel: ['Visits to add', 'Amount', 'Guests'],
  rollout: [
    'Apple push refused 3 updates',
    'Google Wallet update delayed',
    'Two passes have no email',
    'Template change waiting for review',
  ],
  window: ['Evening rush', 'Weekend morning', 'School holidays', 'Quiet hours'],
  flag: ['Birthday today', 'Waiver due', 'First visit', 'Coach'],
  value: ['Visits left', 'Balance', 'Days left', 'Guest passes'],
  plan: ['Always open', 'Evenings only', 'Guest access', 'Staff hours'],
  panel: ['Today', 'Membership', 'Notes', 'Recent visits'],
  header: ['Welcome back', 'Valid today', 'Checked in', 'Membership active'],
  component: ['Database', 'File storage', 'Job queue', 'Workflows', 'Sign-in'],
  incident: [
    'Card scans slow at the front desk',
    'Wallet updates delayed',
    'Email delivery delayed',
  ],
  feature: ['Scanner sessions', 'Connections', 'Team members', 'Webhook endpoints'],
  tagType: ['Wristband', 'Key fob', 'Card', 'Sticker'],
  tag: ['Wristband 14', 'Key fob 3', 'Locker tag 22', 'Guest wristband'],
  scanner: ['Front desk', 'Side door', 'Cafe counter', 'Gear shop till'],
  device: ['Front desk tablet', 'Side door phone', 'Cafe handheld', 'Spare scanner'],
  session: ['Evening shift', 'Morning open', 'Weekend cover', 'League night'],
  connection: ['Booking sheet', 'Shop orders', 'Class bookings', 'Membership export'],
  endpoint: ['Booking events', 'Order system', 'Door log', 'Warehouse hook'],
  key: ['Server integration', 'Mobile app', 'Reporting job', 'Door controller'],
  import: ['Spring members', 'Winter renewals', 'School group', 'League signups'],
  rule: ['Renewal reminder', 'Birthday offer', 'Waiver reminder', 'Welcome message'],
  broadcast: ['Holiday hours', 'Maintenance closure', 'League night moved', 'New route set'],
  keyset: ['Gym doors', 'Lockers', 'Cafe fobs', 'Staff cards'],
  identity: ['Northwind signing identity', 'Northwind staging identity'],
  sandbox: ['Northwind sandbox', 'Integration test sandbox'],
  preset: ['Standard', 'Day-pass gym', 'Membership club', 'Events only'],
  recipe: ['Booking sheet', 'Shop orders', 'Class bookings', 'Webhook push'],
  field: ['Plan', 'Valid until', 'Holder email', 'Member ID', 'Visits left'],
  stat: ['Passes', 'Templates', 'Connections', 'Keys'],
  brand: [ORG],
};

/** Words in a path segment, from camelCase and separators. */
const words = (seg: string): string[] =>
  seg
    .replace(/\[\]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Fields whose entity is told by the API area and the field, before any path word is read. */
const KEYED: [RegExp, RegExp, string][] = [
  [/^status$/, /^title$/, 'incident'],
  [/^status$/, /^label$/, 'component'],
  [/^(scan|scans)$/, /^title$/, 'pass'],
  [/^(scan|scans)$/, /^name$/, 'holder'],
  [/^(scan|scans)$/, /^label$/, 'action'],
  [/^developer$/, /^label$/, 'key'],
  [/^(identities|wallet|identity)$/, /^label$/, 'identity'],
  [/^entitlements$/, /^label$/, 'feature'],
  [/^metrics$/, /^name$/, 'org'],
  [/^(users|me)$/, /^name$/, 'person'],
  [/^me$/, /^title$/, 'pass'],
  [/^(nfc|keysets)$/, /^name$/, 'keyset'],
];

/** Segment word patterns, nearest ancestor first; the first that matches names the entity. */
const RULES: [RegExp, string][] = [
  [/^(sandbox)$/, 'sandbox'],
  [/^(tagtype|bytype|types?)$/, 'tagType'],
  [/^(tags?)$/, 'tag'],
  [/^(visitors?)$/, 'visitor'],
  [/^(personalization|sample|input|previews?|holders?|rows|members?|people)$/, 'holder'],
  [
    /^(user|admin|owner|host|staff|stafflist|author|reviewer|createdby|startedby|endedby|requestedby|approvedby|undoneby|actor|placedby|releasedby|boundby|bound|placed|released|approvals?|session)$/,
    'person',
  ],
  [/^(actions?|byaction)$/, 'action'],
  [/^(input|inputs)$/, 'inputLabel'],
  [/^(flags?)$/, 'flag'],
  [/^(values?)$/, 'value'],
  [/^(plans?)$/, 'plan'],
  [/^(panels?)$/, 'panel'],
  [/^(header|chips?|display|identity)$/, 'header'],
  [/^(byhour|hours?)$/, 'hour'],
  [/^(zones?)$/, 'zone'],
  [/^(places?|parent|occupancy)$/, 'place'],
  [/^(bundles?)$/, 'bundle'],
  [/^(views?|saved)$/, 'view'],
  [/^(assets?|logo|logos)$/, 'asset'],
  [/^(source|files?|uploads?)$/, 'file'],
  [/^(events?)$/, 'event'],
  [/^(failed|failures?|rollout)$/, 'rollout'],
  [/^(windows?|waiting|attention|replace)$/, 'window'],
  [/^(templates?)$/, 'template'],
  [/^(passes|pass)$/, 'pass'],
  [/^(scanners?|terminals?|reader)$/, 'scanner'],
  [/^(devices?)$/, 'device'],
  [/^(connections?)$/, 'connection'],
  [/^(webhooks?|endpoints?)$/, 'endpoint'],
  [/^(keys?|keyset)$/, 'key'],
  [/^(imports?)$/, 'import'],
  [/^(rules?)$/, 'rule'],
  [/^(broadcasts?)$/, 'broadcast'],
  [/^(presets?)$/, 'preset'],
  [/^(recipes?|connectors?)$/, 'recipe'],
  [/^(changes?|rows|samples?|issues?|link|nameinputs|generated|columns?|fields?)$/, 'field'],
  [/^(liveorgs?|orgs?|organizations?|brand)$/, 'org'],
  [/^(counts|stats)$/, 'stat'],
  [/^(apple|google|samsung|identity)$/, 'identity'],
];

const NAMEY = /^(name|label|title|subtitle|alt)$|(Name|Label|Title)$/;
export const isNameKey = (key: string): boolean => NAMEY.test(key);

/** The table for the entity a name field sits in. Throws when none is known. */
export function tableFor(key: string, path: string, tag: string): string {
  const own = words(key).filter((w) => !/^(name|label|title|display|subtitle)$/.test(w));
  const parents = path.split('.').filter(Boolean).slice(0, -1).reverse();
  const first = words(tag)[0] ?? '';
  const candidates = [...own, ...parents.flatMap((p) => words(p)), ...words(tag)];
  for (const w of candidates) for (const [re, table] of RULES) if (re.test(w)) return table;
  for (const [t, k, table] of KEYED) if (t.test(first) && k.test(key)) return table;
  throw new Error(
    `no name table for "${key}" at ${path || '(root)'} of ${tag}: add a table and a rule in tools/lib/example-names.ts`,
  );
}

/** Fields whose entity has no table; the generator fails with this list instead of writing a default. */
export const missing = new Set<string>();

/** One value from the entity's table, picked by the field's place so neighbours differ. */
export function humanName(key: string, path: string, op: string): string {
  let table: string[] | undefined;
  try {
    table = TABLES[tableFor(key, path, op.split('.')[0] ?? '')];
  } catch (e) {
    missing.add((e as Error).message);
    return 'MISSING';
  }
  if (!table) {
    missing.add(`names table for "${key}" at ${path} of ${op} is empty`);
    return 'MISSING';
  }
  // The first value is the entity's own name in the world; later ones fill lists and nested rows.
  const first = !/\[\]|items/.test(path);
  const i = first ? 0 : Number.parseInt(hex(`${op}${path}`, 4), 16) % table.length;
  return table[i] as string;
}

export const REASONS = [
  'Refund issued at the desk.',
  'Duplicate booking.',
  'Member moved away.',
  'Waiver not signed.',
  'Wristband replaced after it was lost.',
  'Payment did not clear.',
  'Class canceled by the coach.',
  'Guest of a member who left.',
  'Membership paused for the winter.',
  'Booked on the wrong date.',
  'Injury; returning in the new year.',
  'Switched to the monthly plan.',
  'Family moved to another city.',
  'Event postponed to spring.',
  'Pass issued to the wrong email.',
  'Trial ended without a renewal.',
  'Chargeback opened by the bank.',
  'Account merged into another.',
  'Staff discount ended.',
  'Birthday party finished.',
  'School term ended.',
  'Gift card used up.',
  'Corporate contract ended.',
  'Left the gym early; refund requested.',
  'Checked in at the wrong door.',
  'Name misspelled at sign-up.',
  'Photo did not match the holder.',
  'Booking sheet row removed.',
  'Coach pass no longer needed.',
  'Locker hire ended.',
];
export const NOTES = [
  'Photo ID checked at the desk.',
  'Prefers email over push.',
  'Allergic to latex chalk.',
  'Needs a harness fitting.',
  'Brings two guests on Fridays.',
  'Waiver on file.',
  'Under 16: a parent signs in.',
  'Asked about the youth league.',
  'Paid by bank transfer.',
  'Uses the side door.',
  'Staff member; free entry.',
  'Lost the wristband once.',
  'Has a left-handed route preference.',
  'Renews each January.',
  'Joined through the school group.',
  'Wants a receipt by email.',
  'First visit was a birthday party.',
  'Coach for the Tuesday class.',
  'Locker 14 until June.',
  'Needs step-free access.',
  'Booked the cafe for after.',
  'Referred by a member.',
  'Pass reissued after a phone change.',
  'Check the waiver at the next visit.',
  'Visits mostly on Saturday mornings.',
  'Volunteer route setter.',
  'Bringing a group of six.',
  'Card on file expires in March.',
  'Prefers the quiet hours.',
  'Training for the winter league.',
];
let reasonN = 0;
let noteN = 0;
/** The next reason or note in turn, so one sentence is used as rarely as the pool allows. */
export const nextReason = (): string => REASONS[reasonN++ % REASONS.length] as string;
export const nextNote = (): string => NOTES[noteN++ % NOTES.length] as string;
