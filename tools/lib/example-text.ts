// What the examples say in free text, by the family of operations a field sits in. Pure data and pickers.
// Every sentence belongs to one family and one field, so example-lint.ts can tell a sentence that is out of place:
// a broadcast message in a template issue, a refund reason on an Apple push. Codes live in example-fields.ts.
export const FAMILIES = [
  'scan',
  'passes',
  'templates',
  'rollouts',
  'imports',
  'connections',
  'webhooks',
  'messages',
  'org',
  'identities',
  'status',
] as const;
export type Family = (typeof FAMILIES)[number];

const TAG_FAMILY: Record<string, Family> = {
  scan: 'scan',
  scans: 'scan',
  scanners: 'scan',
  'scan-zones': 'scan',
  'scan-events': 'scan',
  'scan-staff': 'scan',
  'scan-display': 'scan',
  'roll-calls': 'scan',
  'nfc-tags': 'scan',
  'nfc-keysets': 'scan',
  passes: 'passes',
  holders: 'passes',
  delivery: 'passes',
  bundles: 'passes',
  me: 'passes',
  'join-links': 'passes',
  'wallet-providers': 'passes',
  apple: 'passes',
  templates: 'templates',
  'pass-imports': 'imports',
  connections: 'connections',
  connectors: 'connections',
  webhooks: 'webhooks',
  events: 'webhooks',
  broadcasts: 'messages',
  'message-rules': 'messages',
  sandbox: 'messages',
  identities: 'identities',
  'identity-runs': 'identities',
  'wallet-credentials': 'identities',
  'wallet-enrolments': 'identities',
  'wallet-identities': 'identities',
  'wallet-platform': 'identities',
  status: 'status',
};

/** The family of an operation: its tag's, except a template rollout, which is its own. */
export function familyOf(op: string): Family {
  const [tag = '', name = ''] = op.split('.');
  if (tag === 'templates' && /Rollout/.test(name)) return 'rollouts';
  return TAG_FAMILY[tag] ?? 'org';
}

/**
 * Sentences by family, then by `<field>` or `<entity>.<field>`: the field is the JSON key the sentence goes in, the
 * entity (a word of the path) narrows it when one family writes the same key on different things. A sentence appears
 * once in the whole table.
 */
export const SENTENCES: Record<Family, Record<string, readonly string[]>> = {
  scan: {
    'event.note': [
      'Doors open 30 minutes early for members.',
      'Youth league night: no outside shoes past the mat line.',
      'Bouldering cave closes at 21:00 for route setting.',
    ],
    'visitor.note': [
      'Trial session with a coach',
      'Birthday party, 6 guests',
      'School group, teacher signs',
    ],
    body: [
      'Waiver signed on paper; scan it to the file.',
      'Asked for a harness fitting on the next visit.',
      'Paid for chalk at the desk; receipt given.',
    ],
    welcome: ['Welcome to Northwind'],
    figure: ['$12.00'],
    refusedLine: ['Please see the front desk'],
    'chip.text': ['Day pass'],
    'line.text': ['Balance after: 7 visits'],
    'row.text': ['Today'],
    'row.detail': ['Since 18:05'],
    // Setup checks name a copy key, not a sentence (shared/copy/scan-setup.ts).
  },
  passes: {
    'remove.message': ['Your day pass was replaced by a monthly membership.'],
    // passes/bulk-service.ts: the reason a ticket was left out of a print run.
    'skipped.reason': ['Paper is off for Day pass'],
  },
  templates: {
    // templates/package/images.ts: the warnings a package check writes.
    message: [
      'icon@2x.png derived from the @3x image.',
      'strip.png is not used by generic; left out of the pass.',
    ],
    note: ['Logo and colors match the brand guide.'],
    'rollback.reason': ['The new logo is cropped on older iPhones.'],
  },
  rollouts: {
    // templates/rollout.ts and the rebuild's recorded errors.
    reason: [
      'The pass changed. Retry.',
      'The card has 12 stamps; this version allows 10. Raise the maximum or redeem first.',
    ],
    text: ['31 Dec 2026', '31 Jan 2027', 'Day pass has a new design.'],
  },
  imports: {
    // passes/import-messages.ts: a row's first problem, and a warning a check writes.
    message: ['Email is not valid.', 'Name was edited in PassBook; the edit is kept.'],
  },
  connections: {
    // connectors/csv-url: what a test read.
    detail: ['3 rows. Columns: Booking ID, Name, Email, Plan, Valid until'],
  },
  webhooks: {},
  messages: {
    'broadcast.message': [
      'The gym closes at 18:00 on 24 December.',
      'The bouldering cave reopens on Saturday with new routes.',
    ],
    'rule.message': ['Your membership renews in 7 days.'],
    text: ['Your pass is ready. Day pass for Ada Example.'],
  },
  org: {
    'hold.reason': [
      'Chargeback dispute: keep records until the bank closes it.',
      'Insurance claim after a fall on 12 November.',
    ],
    note: ['Pilot pricing through March.', 'Two extra scanners for the league season.'],
    // shared/copy/pass-setup.ts: the setup checks.
    message: ["Apple passes sign with PassBook's shared ID."],
  },
  identities: {
    'hold.reason': ['Issuer account under review by Google.'],
  },
  status: {
    note: [
      'Scans answer in 3 to 5 seconds. Investigating.',
      'Apple push was slow for 20 minutes. Back to normal.',
      'Fixed a slow query. Scans answer in under a second.',
    ],
    detail: ['Sending as hello@example.com', 'Last run 2 minutes ago.'],
  },
};

/** Every sentence, to the family and field it was written for. */
export const SENTENCE_HOME: Map<string, { family: Family; field: string }> = new Map(
  FAMILIES.flatMap((family) =>
    Object.entries(SENTENCES[family]).flatMap(([slot, list]) =>
      list.map((text) => [text, { family, field: slot.split('.').pop() as string }] as const),
    ),
  ),
);

/** Fields whose prose must come from the table above. */
export const PROSE_KEYS =
  /^(reason|message|note|body|welcome|refusedLine|detail|text|errorDetail|figure)$/;

/**
 * A sentence for a free-text field, from the operation's family. The entity is the nearest path word that names a
 * slot; the pick is by the field's place, so a value is stable whatever is generated around it.
 */
export function sentenceFor(op: string, key: string, path: string): string | undefined {
  const pools = SENTENCES[familyOf(op)];
  const [tag = '', name = ''] = op.split('.');
  // Nearest first: the path's words, then the operation's (`postPassesByIdRemove` -> remove), then its tag's.
  const words = [
    ...path
      .split(/[.[\]]+/)
      .filter(Boolean)
      .reverse(),
    ...name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(' ')
      .reverse(),
    ...tag.split('-').reverse(),
  ].map((w) => w.replace(/(?<=[a-z]{3})s$/, ''));
  const slots = Object.keys(pools).filter((s) => s.split('.').pop() === key);
  const slot =
    words.map((w) => slots.find((s) => s.startsWith(`${w}.`))).find(Boolean) ??
    slots.find((s) => s === key);
  const list = slot ? pools[slot] : undefined;
  if (!list?.length) return undefined;
  // The first of a kind is the world's own; later list items take the next ones, so a list is never one line twice.
  const at = Number(path.match(/\[(\d+)\](?!.*\[\d+\])/)?.[1] ?? 0);
  return list[at % list.length];
}
