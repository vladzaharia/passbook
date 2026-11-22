// The fictional world the reference examples describe: one org, one id table, one template. Pure data.

/** `0193a1b2-7c00-7000-8000-0000000000xx`: a fixed UUIDv7 per resource, shared by every example that names it. */
const id = (n: number): string => `0193a1b2-7c00-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const ORG = 'Northwind Climbing';
export const ORG_SLUG = 'northwind-climbing';
export const SITE = 'https://northwind.example.com';
export const API = 'https://passbook.mobile';

/** Resource kind to its id. Kinds are the singular key names the API uses (`templateId`, `scannerId`). */
export const IDS: Record<string, string> = {
  org: id(0xa1),
  template: id(0xb1),
  pass: id(0xc1),
  identity: id(0xd1),
  event: id(0xe1),
  holder: id(0xf1),
  user: id(0x11),
  key: id(0x21),
  scanner: id(0x31),
  keyset: id(0x41),
  connection: id(0x51),
  endpoint: id(0x61),
  import: id(0x71),
  zone: id(0x81),
  session: id(0x91),
  device: id(0x12),
  staff: id(0x22),
  bundle: id(0x32),
  broadcast: id(0x42),
  rule: id(0x52),
  visitor: id(0x62),
  rollCall: id(0x72),
  tag: id(0x82),
  candidate: id(0x92),
  release: id(0x13),
  run: id(0x23),
  delivery: id(0x33),
  scan: id(0x43),
  print: id(0x53),
  job: id(0x63),
  serial: id(0xc2),
  action: id(0x73),
  member: id(0x11),
  key2: id(0x24),
  idem: id(0xaa),
  incident: id(0xab),
  incident2: id(0xac),
};

/** A tag or a key name (singular, lower-case) to the kind of resource whose id it holds. */
export const KIND_OF_TAG: Record<string, string> = {
  passes: 'pass',
  templates: 'template',
  scanners: 'scanner',
  'nfc-keysets': 'keyset',
  'nfc-tags': 'tag',
  connections: 'connection',
  webhooks: 'endpoint',
  'api-keys': 'key',
  orgs: 'org',
  'pass-imports': 'import',
  'scan-zones': 'zone',
  'scan-events': 'event',
  'scan-staff': 'staff',
  bundles: 'bundle',
  broadcasts: 'broadcast',
  'message-rules': 'rule',
  visitors: 'visitor',
  'roll-calls': 'rollCall',
  holders: 'holder',
  identities: 'identity',
  users: 'user',
  events: 'event',
  scans: 'scan',
  scan: 'scan',
  delivery: 'delivery',
};

/** What a person-free field is called, by kind. */
export const NAMES: Record<string, string> = {
  org: ORG,
  template: 'Day pass',
  scanner: 'Front desk',
  keyset: 'Gym doors',
  connection: 'Booking sheet',
  endpoint: 'Booking events',
  key: 'Server integration',
  import: 'Spring members',
  zone: 'Main hall',
  event: 'Open climbing',
  session: 'Evening shift',
  device: 'Front desk tablet',
  staff: 'Sam Rivera',
  bundle: 'Family bundle',
  broadcast: 'Holiday hours',
  rule: 'Renewal reminder',
  identity: 'Northwind signing identity',
  visitor: 'Jordan Lee',
  user: 'Sam Rivera',
  holder: 'Ada Example',
  tag: 'Wristband 14',
  pass: 'Day pass',
};

/** The one template every pass example draws from. */
export const TEMPLATE = {
  slug: 'day-pass',
  name: 'Day pass',
  description: 'A day pass for the climbing gym, scanned at the front desk.',
  sample: { name: 'Ada Example', tier: 'Day pass', validUntil: '2026-12-31' },
  fieldSources: { name: 'manual', tier: 'manual', validUntil: 'manual' },
  passJson: {
    formatVersion: 1,
    passTypeIdentifier: 'pass.mobile.passbook.northwind',
    serialNumber: IDS.serial,
    organizationName: ORG,
    description: 'Day pass',
    backgroundColor: 'rgb(17, 42, 74)',
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 196, 0)',
    generic: {
      primaryFields: [{ key: 'name', label: 'Guest', value: 'Ada Example' }],
      secondaryFields: [{ key: 'tier', label: 'Pass', value: 'Day pass' }],
      auxiliaryFields: [{ key: 'validUntil', label: 'Valid until', value: '2026-12-31' }],
    },
  },
};

const BASE = Date.UTC(2026, 10, 24, 15, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Fixed times near one date, as integer ms. */
export const T = {
  now: BASE,
  created: BASE - 14 * DAY,
  updated: BASE - 2 * DAY,
  recent: BASE - 3 * 60 * MIN,
  soon: BASE + 10 * MIN,
  tomorrow: BASE + DAY,
  validFrom: BASE,
  validUntil: BASE + 30 * DAY,
  later: BASE + 7 * DAY,
};

/** Reasons, messages and codes that read like traffic. */
export const TEXT = {
  reason: 'Left the gym early; refund issued at the desk.',
  message: 'The gym closes at 18:00 on 24 December.',
  note: 'Photo ID checked at the desk.',
  detail: 'The pass has already been used today.',
  errorCode: 'RATE_LIMITED',
  version: '3',
  timeZone: 'America/Los_Angeles',
  locale: 'en-US',
};

/**
 * An API key's lookup prefix (8 characters) and an example test-mode secret. The real tail is 43 characters; the
 * example's is 42, so `apiKeyPrefixOf` rejects it and no example can ever pass for a working key.
 */
export const KEY_PREFIX = 'k3Qx9Zt2';
export const NEW_KEY_PREFIX = 'p7Wm4Hn8';
export const keySecret = (prefix: string): string =>
  `pb_test_${prefix}_northwind-demo-key-do-not-use-${hex(`secret${prefix}`, 12)}`;
/** A webhook signing secret, a readable demo word plus a short hex. */
export const webhookSecret = (seed: string): string => `whsec_demo_northwind_${hex(seed, 6)}`;

/** Stable fake hex of `len` digits from a seed, so no two fields share a sample. */
export function hex(seed: string, len: number): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = '';
  while (out.length < len) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    out += ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

/** A pass as the API returns it; every example that shows a pass shows this one. */
export const PASS = {
  id: IDS.pass,
  orgId: IDS.org,
  templateId: IDS.template,
  templateVersion: '3',
  identityId: IDS.identity,
  serial: IDS.serial,
  title: 'Day pass',
  subtitle: 'Ada Example',
  externalId: 'booking_8841',
  status: 'active',
  mode: 'live',
  version: 1,
  connectionId: null,
  externalRef: null,
  syncErrorCode: null,
  holderEmail: 'ada@example.com',
  holderState: 'waiting',
  ownerUserId: null,
  deviceCount: 0,
  removedAt: null,
  modifiedAt: T.recent,
  createdAt: T.recent,
  reissueRequired: false,
  ownerName: null,
  ownerEmail: null,
  personalization: TEMPLATE.sample,
  fieldSources: TEMPLATE.fieldSources,
  registrations: 0,
  lastRefreshedAt: null,
  versions: [
    {
      version: 1,
      templateVersion: '3',
      cause: 'create',
      source: null,
      actorType: 'api_key',
      actorId: IDS.key,
      createdAt: T.recent,
      purged: false,
    },
  ],
  deliveries: [],
  warnings: [],
  passJson: TEMPLATE.passJson,
  assetBaseUrl: `${API}/assets/${IDS.pass}/`,
  assetNames: ['icon.png', 'icon@2x.png', 'logo.png'],
  blockedUsers: [],
  downloadUrl: `${SITE}/p/${IDS.pass}.pkpass`,
  publicUrl: `${SITE}/p/xK3v9QmT2Lw8`,
};

/** The template every pass and scan example uses. */
export const TEMPLATE_DETAIL = {
  id: IDS.template,
  orgId: IDS.org,
  orgName: ORG,
  slug: TEMPLATE.slug,
  name: TEMPLATE.name,
  description: TEMPLATE.description,
  origin: 'uploaded',
  status: 'active',
  activeVersion: '3',
  styles: ['generic'],
  passCount: 128,
  createdAt: T.created,
  updatedAt: T.updated,
  sample: TEMPLATE.sample,
  versions: [
    {
      version: '3',
      createdAt: T.updated,
      createdBy: IDS.user,
      assets: [],
      report: { ok: true, issues: [] },
      active: true,
      displayOnly: false,
      passCount: 128,
    },
  ],
};

/** The CSV every import example uploads, and the plan that maps it onto the template. */
export const MEMBERS_CSV =
  'Holder email,Name,Tier,Valid until,Member ID\nada@example.com,Ada Example,Day pass,2026-12-31,NW-1001\ngrace@example.com,Grace Okafor,Day pass,2026-12-31,NW-1002\nalan@example.com,Alan Reyes,Day pass,2027-01-15,NW-1003\n';
export const IMPORT_PLAN = {
  mapping: {
    name: { from: '/Name' },
    tier: { from: '/Tier' },
    validUntil: {
      from: '/Valid until',
      transform: { kind: 'date', options: { input: 'iso', output: 'iso' } },
    },
  },
  holderEmail: { from: '/Holder email' },
  externalId: { from: '/Member ID' },
  match: 'externalId',
  keepManual: false,
  save: true,
  overrides: {},
};

/** A finished import, as every import example shows it. */
export const IMPORT = {
  id: IDS.import,
  templateId: IDS.template,
  templateVersion: '3',
  mode: 'live',
  state: 'done',
  source: { kind: 'file', name: 'members.csv' },
  columns: [
    {
      pointer: '/Holder email',
      label: 'Holder email',
      samples: ['ada@example.com', 'grace@example.com'],
    },
    { pointer: '/Name', label: 'Name', samples: ['Ada Example', 'Grace Okafor'] },
    { pointer: '/Tier', label: 'Tier', samples: ['Day pass'] },
    { pointer: '/Valid until', label: 'Valid until', samples: ['2026-12-31', '2027-01-15'] },
    { pointer: '/Member ID', label: 'Member ID', samples: ['NW-1001', 'NW-1002'] },
  ],
  plan: IMPORT_PLAN,
  counts: {
    rows: 3,
    create: 2,
    update: 1,
    unchanged: 0,
    errors: 0,
    warnings: 0,
    emailable: 2,
    errorsCreate: 0,
    errorsUpdate: 0,
  },
  previews: [
    {
      row: 2,
      action: 'create',
      input: { name: 'Ada Example', tier: 'Day pass', validUntil: '2026-12-31' },
    },
    {
      row: 3,
      action: 'create',
      input: { name: 'Grace Okafor', tier: 'Day pass', validUntil: '2026-12-31' },
    },
    {
      row: 4,
      action: 'update',
      input: { name: 'Alan Reyes', tier: 'Day pass', validUntil: '2027-01-15' },
    },
  ],
  problems: [],
  problemTotals: { errors: 0, warnings: 0 },
  problemsTruncated: false,
  emailBudget: 500,
  email: true,
  progress: {
    done: 3,
    created: 2,
    updated: 1,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    notEmailed: 0,
    removed: 0,
  },
  errorCode: null,
  errorFile: false,
  createdAt: T.recent - 20 * MIN,
  checkedAt: T.recent - 18 * MIN,
  committedAt: T.recent - 15 * MIN,
  finishedAt: T.recent - 14 * MIN,
  expiresAt: T.later,
  emailHoldUntil: T.recent - 10 * MIN,
};

/** Object shapes the API repeats, by a property that gives them away: the canonical example, trimmed to the schema. */
export const CANON: { has: string[]; value: Record<string, unknown> }[] = [
  { has: ['serial', 'templateId', 'holderEmail'], value: PASS },
  { has: ['slug', 'activeVersion', 'orgName'], value: TEMPLATE_DETAIL },
  { has: ['templateId', 'state', 'plan', 'counts'], value: IMPORT },
];

/** A PEM block that shows the shape and none of the material: a header, an ellipsis, a footer. */
export const pem = (label: string): string =>
  `${['-----BEGIN', label, '-----'].join(' ').replace(' -----', '-----')}\n…\n${['-----END', label, '-----'].join(' ').replace(' -----', '-----')}`;
