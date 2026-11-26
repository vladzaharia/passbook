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
  mapping: ['Members export', 'Booking sheet columns'],
  file: ['members.csv', 'spring-members.csv', 'guest-list.csv', 'tags.csv'],
  hour: ['9 AM', '10 AM', '5 PM', '6 PM', '7 PM'],
  action: ['Admit', 'Check out', 'Add a visit', 'Redeem reward'],
  inputLabel: ['Visits to add', 'Amount', 'Guests'],
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
  tagType: ['Member wristband', 'Wristband', 'Key fob', 'Card', 'Sticker'],
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
  operation: ['Delete sandbox', 'Sync connection', 'Update passes'],
  operationStep: ['Remove Test passes', 'Revoke keys', 'Send pages'],
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
  [/^operations$/, /^title$/, 'operation'],
  [/^operations$/, /^label$/, 'operationStep'],
  [/^status$/, /^title$/, 'incident'],
  [/^status$/, /^label$/, 'component'],
  [/^(scan|scans)$/, /^title$/, 'pass'],
  [/^(scan|scans)$/, /^name$/, 'holder'],
  [/^(scan|scans)$/, /^label$/, 'action'],
  [/^(developer|workbench)$/, /^label$/, 'key'],
  [/^(identities|wallet|identity)$/, /^label$/, 'identity'],
  [/^entitlements$/, /^label$/, 'feature'],
  [/^metrics$/, /^name$/, 'org'],
  [/^(users|me)$/, /^name$/, 'person'],
  [/^developer$/, /^name$/, 'person'],
  [/^me$/, /^title$/, 'pass'],
  [/^(nfc|keysets)$/, /^name$/, 'keyset'],
];

/** Segment word patterns, nearest ancestor first; the first that matches names the entity. */
const RULES: [RegExp, string][] = [
  // An operation a start answers (`.operation.title`, `.operation.steps[].label`), whatever the area.
  [/^(steps)$/, 'operationStep'],
  [/^(operation)$/, 'operation'],
  [/^(sandbox)$/, 'sandbox'],
  [/^(tagtype|types?)$/, 'tagType'],
  [/^(tags?)$/, 'tag'],
  [/^(visitors?)$/, 'visitor'],
  [/^(personalization|sample|input|previews?|holders?|rows|members?|people)$/, 'holder'],
  [
    /^(user|admin|owner|host|staff|stafflist|author|reviewer|createdby|startedby|endedby|requestedby|approvedby|undoneby|actor|placedby|releasedby|boundby|bound|placed|released|approvals?)$/,
    'person',
  ],
  // A scanning session is named for a shift or a place, never for the person who runs it.
  [/^(sessions?)$/, 'session'],
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
  [/^(failed)$/, 'pass'],
  [/^(windows?|waiting|attention|replace)$/, 'window'],
  [/^(templates?)$/, 'template'],
  [/^(passes|pass)$/, 'pass'],
  [/^(scanners?|terminals?|reader|doors?|checked)$/, 'scanner'],
  [/^(devices?)$/, 'device'],
  [/^(connections?)$/, 'connection'],
  [/^(webhooks?|endpoints?)$/, 'endpoint'],
  [/^(keysets?)$/, 'keyset'],
  [/^(keys?)$/, 'key'],
  [/^(imports?)$/, 'import'],
  [/^(rules?)$/, 'rule'],
  [/^(broadcasts?)$/, 'broadcast'],
  [/^(presets?)$/, 'preset'],
  [/^(recipes?|connectors?)$/, 'recipe'],
  [
    /^(changes?|rows|samples?|issues?|problems?|link|nameinputs|generated|columns?|fields?)$/,
    'field',
  ],
  [/^(liveorgs?|orgs?|organizations?|brand)$/, 'org'],
  [/^(counts|stats)$/, 'stat'],
  [/^(apple|google|samsung|identity)$/, 'identity'],
];

/** Operations under the `scanners` tag that return a scanning session or one of its devices. */
const OP_TABLES: [RegExp, string][] = [
  [/TagTypes/, 'tagType'],
  [/ScanningSessions.*Devices/, 'device'],
  [/ScanningSessions/, 'session'],
];

const NAMEY = /^(name|label|title|subtitle|alt)$|(Name|Label|Title)$/;
export const isNameKey = (key: string): boolean => NAMEY.test(key);

/** The table for the entity a name field sits in. Throws when none is known. */
export function tableFor(key: string, path: string, tag: string, name = ''): string {
  const own = words(key).filter((w) => !/^(name|label|title|display|subtitle)$/.test(w));
  const parents = path.split('.').filter(Boolean).slice(0, -1).reverse();
  const first = words(tag)[0] ?? '';
  // Scan counts by type are by pass type: the template (contracts/scan-session.ts).
  if (/byType/.test(path)) return 'template';
  // A broadcast lists the passes it reached, each by its own title.
  if (tag === 'broadcasts' && key === 'title') return 'pass';
  if (tag === 'pass-imports' && /Mappings/.test(name)) return 'mapping';
  if (tag === 'metrics' && /(^|\.)live\[/.test(path)) return 'event';
  const candidates = [...own, ...parents.flatMap((p) => words(p))];
  for (const w of candidates) for (const [re, table] of RULES) if (re.test(w)) return table;
  // Operations whose tag names a different resource than they return.
  for (const [re, table] of OP_TABLES) if (re.test(name)) return table;
  candidates.push(...words(tag));
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
    table = TABLES[tableFor(key, path, op.split('.')[0] ?? '', op.split('.')[1])];
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
