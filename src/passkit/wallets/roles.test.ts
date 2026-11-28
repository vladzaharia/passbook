import { describe, expect, it } from 'vitest';
import type { WalletRoleSource } from '../template/wallets/schema.ts';
import type { PassStyle, SemanticTags } from '../types.ts';
import type { RoleInput } from './role-rules.ts';
import { ROLE_KINDS, resolveRoles } from './roles.ts';
import { type ResolvedRoles, type ViewField, WALLET_ROLES, type WalletRole } from './types.ts';
import { fieldPath, parseLinks } from './view-fields.ts';

type Group = ViewField['group'];
const field = (
  group: Group,
  key: string,
  value: string | number,
  extra: Partial<ViewField> = {},
): ViewField => ({
  group,
  key,
  path: fieldPath(group, key),
  order: 0,
  value,
  text: String(value),
  links: [],
  ...extra,
});

const input = (style: PassStyle, extra: Partial<RoleInput> = {}): RoleInput => ({
  style,
  org: 'Acme',
  fields: [],
  barcodes: [],
  locations: [],
  ...extra,
});
const withSemantics = (style: PassStyle, semantics: SemanticTags, extra: Partial<RoleInput> = {}) =>
  input(style, { semantics, ...extra });
const onField = (group: Group, semantics: SemanticTags, label = 'L') =>
  field(group, 'f', 'shown', { label, semantics });

const run = (
  i: RoleInput,
  manifest?: Partial<Record<WalletRole, WalletRoleSource>>,
  evaluate: (e: unknown) => never | undefined | string | number = (e) => String(e),
) => resolveRoles(i, manifest, evaluate as never);

const text = (roles: ResolvedRoles, role: WalletRole): string | undefined => {
  const v = roles[role];
  if (!v) return undefined;
  if ('text' in v) return v.text;
  if ('iso' in v) return v.iso;
  if ('amount' in v) return `${v.amount} ${v.currencyCode}`;
  if ('latitude' in v) return `${v.latitude},${v.longitude}`;
  if ('channel' in v) return v.channel;
  if ('links' in v) return v.links.map((l) => l.url).join(' ');
  if (v.kind === 'app') return `app:${v.name}:${v.url}`;
  return JSON.stringify(v);
};

/** One row of the architecture 2.2 table: where it resolves from, and the nothing case. */
interface Row {
  role: WalletRole;
  hits: [name: string, source: 'semantics' | 'style', input: RoleInput, expected: string][];
  /** An input that has everything the other rows use but nothing for this role. */
  misses: [name: string, input: RoleInput][];
}

const PRIMARY = field('primary', 'p', 'Primary', { label: 'Pl' });
const SECONDARY = field('secondary', 'q', 'Secondary');
const ALL_FIELDS = [PRIMARY, SECONDARY];
const bare = input('generic', { fields: ALL_FIELDS });

const ROWS: Row[] = [
  {
    role: 'title',
    hits: [['primaryFields[0]', 'style', input('generic', { fields: ALL_FIELDS }), 'Primary']],
    misses: [['no fields falls back to the organization', input('generic')]],
  },
  {
    role: 'subtitle',
    hits: [['secondaryFields[0]', 'style', input('generic', { fields: ALL_FIELDS }), 'Secondary']],
    misses: [['no secondary field', input('generic', { fields: [PRIMARY] })]],
  },
  {
    role: 'eventName',
    hits: [
      ['semantics eventName', 'semantics', withSemantics('generic', { eventName: 'Gig' }), 'Gig'],
      [
        'eventTicket primaryFields[0]',
        'style',
        input('eventTicket', { fields: ALL_FIELDS }),
        'Primary',
      ],
    ],
    misses: [
      ['primaryFields[0] only on an event ticket', input('storeCard', { fields: ALL_FIELDS })],
    ],
  },
  {
    role: 'eventStart',
    hits: [
      [
        'semantics eventStartDate',
        'semantics',
        withSemantics('generic', { eventStartDate: '2030-02-02T20:00:00Z' }),
        '2030-02-02T20:00:00Z',
      ],
      [
        'semantics eventStartDateInfo.date',
        'semantics',
        withSemantics('generic', { eventStartDateInfo: { date: '2030-03-03T20:00:00Z' } }),
        '2030-03-03T20:00:00Z',
      ],
      [
        'the template start input',
        'style',
        input('generic', { declared: { start: '2030-01-01T10:30:00Z' } }),
        '2030-01-01T10:30:00Z',
      ],
    ],
    misses: [
      ['no dates', bare],
      ['a tag that is not a date', withSemantics('generic', { eventStartDate: 'later' })],
    ],
  },
  {
    role: 'eventEnd',
    hits: [
      [
        'semantics eventEndDate',
        'semantics',
        withSemantics('generic', { eventEndDate: '2030-02-02T23:00:00Z' }),
        '2030-02-02T23:00:00Z',
      ],
      [
        'the template end input',
        'style',
        input('generic', { declared: { end: '2030-01-01T12:30:00Z' } }),
        '2030-01-01T12:30:00Z',
      ],
    ],
    misses: [['a start only', input('generic', { declared: { start: '2030-01-01T10:00:00Z' } })]],
  },
  {
    role: 'doorsOpen',
    hits: [
      [
        'semantics venueDoorsOpenDate',
        'semantics',
        withSemantics('generic', { venueDoorsOpenDate: '2030-02-02T19:00:00Z' }),
        '2030-02-02T19:00:00Z',
      ],
    ],
    misses: [
      [
        'a declared start is not doors',
        input('generic', { declared: { start: '2030-01-01T10:00:00Z' } }),
      ],
    ],
  },
  {
    role: 'venueName',
    hits: [
      ['semantics venueName', 'semantics', withSemantics('generic', { venueName: 'Hall' }), 'Hall'],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'venueAddress',
    hits: [
      [
        'venueRoom and venueRegionName',
        'semantics',
        withSemantics('generic', { venueRoom: 'Main', venueRegionName: 'Oslo' }),
        'Main, Oslo',
      ],
      [
        'venueRegionName alone',
        'semantics',
        withSemantics('generic', { venueRegionName: 'Oslo' }),
        'Oslo',
      ],
    ],
    misses: [['venueName is not an address', withSemantics('generic', { venueName: 'Hall' })]],
  },
  {
    role: 'venueLocation',
    hits: [
      [
        'semantics venueLocation',
        'semantics',
        withSemantics('generic', { venueLocation: { latitude: 1, longitude: 2 } }),
        '1,2',
      ],
      [
        'locations[0]',
        'style',
        input('generic', {
          locations: [
            { latitude: 3, longitude: 4 },
            { latitude: 5, longitude: 6 },
          ],
        }),
        '3,4',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'seat',
    hits: [
      [
        'seats[0].seatNumber',
        'semantics',
        withSemantics('generic', {
          seats: [{ seatNumber: '14', seatRow: 'C' }, { seatNumber: '15' }],
        }),
        '14',
      ],
    ],
    misses: [['a seat without a number', withSemantics('generic', { seats: [{ seatRow: 'C' }] })]],
  },
  {
    role: 'row',
    hits: [
      [
        'seats[0].seatRow',
        'semantics',
        withSemantics('generic', { seats: [{ seatNumber: '14', seatRow: 'C' }] }),
        'C',
      ],
    ],
    misses: [['a seat without a row', withSemantics('generic', { seats: [{ seatNumber: '14' }] })]],
  },
  {
    role: 'section',
    hits: [
      [
        'seats[0].seatSection',
        'semantics',
        withSemantics('generic', { seats: [{ seatSection: 'B' }] }),
        'B',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'gate',
    hits: [
      [
        'semantics venueEntranceGate',
        'semantics',
        withSemantics('generic', { venueEntranceGate: 'G4' }),
        'G4',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'ticketHolder',
    hits: [
      [
        'semantics attendeeName',
        'semantics',
        withSemantics('generic', { attendeeName: 'Ada' }),
        'Ada',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'ticketNumber',
    hits: [],
    misses: [['no tag and no default', input('eventTicket', { fields: ALL_FIELDS })]],
  },
  {
    role: 'confirmationCode',
    hits: [
      [
        'semantics confirmationNumber',
        'semantics',
        withSemantics('generic', { confirmationNumber: 'ABC123' }),
        'ABC123',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'eventId',
    hits: [],
    misses: [['no tag and no default', input('eventTicket', { fields: ALL_FIELDS })]],
  },
  {
    role: 'memberId',
    hits: [
      [
        'semantics membershipProgramNumber',
        'semantics',
        withSemantics('storeCard', { membershipProgramNumber: 'M-1' }),
        'M-1',
      ],
      [
        'storeCard barcode altText',
        'style',
        input('storeCard', {
          barcodes: [
            { format: 'f', kind: 'qr', message: 'm', encoding: 'e' },
            { format: 'f', kind: 'qr', message: 'm2', encoding: 'e', altText: 'ALT-2' },
          ],
        }),
        'ALT-2',
      ],
    ],
    misses: [
      [
        'altText only counts on a store card',
        input('coupon', {
          barcodes: [{ format: 'f', kind: 'qr', message: 'm', encoding: 'e', altText: 'A' }],
        }),
      ],
    ],
  },
  {
    role: 'memberName',
    hits: [
      [
        'semantics passengerName',
        'semantics',
        withSemantics('generic', { passengerName: { givenName: 'Ada', familyName: 'Lovelace' } }),
        'Ada Lovelace',
      ],
      [
        'semantics attendeeName',
        'semantics',
        withSemantics('generic', { attendeeName: 'Grace' }),
        'Grace',
      ],
    ],
    misses: [['an empty name', withSemantics('generic', { passengerName: {} })]],
  },
  {
    role: 'tier',
    hits: [
      [
        'semantics membershipProgramStatus',
        'semantics',
        withSemantics('storeCard', { membershipProgramStatus: 'Gold' }),
        'Gold',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'points',
    hits: [],
    misses: [['no tag and no default', input('storeCard', { fields: ALL_FIELDS })]],
  },
  {
    role: 'pointsLabel',
    hits: [],
    misses: [['no tag and no default', input('storeCard', { fields: ALL_FIELDS })]],
  },
  {
    role: 'balance',
    hits: [
      [
        'semantics balance',
        'semantics',
        withSemantics('storeCard', { balance: { amount: '12.50', currencyCode: 'EUR' } }),
        '12.50 EUR',
      ],
    ],
    misses: [
      ['half a balance', withSemantics('storeCard', { balance: { amount: '12.50' } as never })],
    ],
  },
  { role: 'giftCardNumber', hits: [], misses: [['no tag and no default', bare]] },
  { role: 'giftCardPin', hits: [], misses: [['no tag and no default', bare]] },
  {
    role: 'offerTitle',
    hits: [
      ['coupon primaryFields[0]', 'style', input('coupon', { fields: ALL_FIELDS }), 'Primary'],
    ],
    misses: [['not a coupon', input('generic', { fields: ALL_FIELDS })]],
  },
  {
    role: 'offerDetails',
    hits: [
      [
        'coupon back fields',
        'style',
        input('coupon', { fields: [field('back', 'a', 'One'), field('back', 'b', 'Two')] }),
        'One\nTwo',
      ],
    ],
    misses: [['no back fields', input('coupon', { fields: ALL_FIELDS })]],
  },
  {
    role: 'finePrint',
    hits: [],
    misses: [['no tag and no default', input('coupon', { fields: [field('back', 'terms', 'T')] })]],
  },
  {
    role: 'redemptionChannel',
    hits: [['coupon: both', 'style', input('coupon'), 'both']],
    misses: [['not a coupon', input('generic')]],
  },
  {
    role: 'validFrom',
    hits: [
      [
        'the template start input',
        'style',
        input('generic', { declared: { start: '2030-01-01T10:00:00Z' } }),
        '2030-01-01T10:00:00Z',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'validUntil',
    hits: [
      [
        'expirationDate',
        'style',
        input('generic', { expirationDate: '2031-01-01T00:00:00Z' }),
        '2031-01-01T00:00:00Z',
      ],
    ],
    misses: [['none', bare]],
  },
  {
    role: 'appLink',
    hits: [
      [
        'the organization settings',
        'style',
        input('generic', { appLink: { name: 'Acme', url: 'https://acme.example' } }),
        'app:Acme:https://acme.example',
      ],
    ],
    misses: [
      ['no settings', bare],
      ['empty settings', input('generic', { appLink: {} })],
    ],
  },
  {
    role: 'support',
    hits: [
      [
        'back-field tel, mailto and https links',
        'style',
        input('generic', {
          fields: [
            field('back', 'phone', 'tel:+4712345678', {
              links: parseLinks(undefined, 'tel:+4712345678'),
            }),
            field('back', 'web', 'Site', {
              links: parseLinks('<a href="https://acme.example">Site</a>', 'Site'),
            }),
            field('back', 'mail', 'mailto:a@acme.example', {
              links: parseLinks(undefined, 'mailto:a@acme.example'),
            }),
            field('back', 'dup', 'Again', {
              links: parseLinks('<a href="https://acme.example">Again</a>', 'Again'),
            }),
            field('back', 'plain', 'Terms'),
          ],
        }),
        'tel:+4712345678 https://acme.example mailto:a@acme.example',
      ],
    ],
    misses: [
      ['no links', input('generic', { fields: [field('back', 'plain', 'Terms')] })],
      [
        'front-field links',
        input('generic', {
          fields: [
            field('primary', 'w', 'x', {
              links: parseLinks('<a href="https://x.example">x</a>', 'x'),
            }),
          ],
        }),
      ],
    ],
  },
];

describe('role resolution, row by row (architecture 2.2)', () => {
  it('has a row for every role', () => {
    expect(ROWS.map((r) => r.role).sort()).toEqual([...WALLET_ROLES].sort());
  });

  for (const row of ROWS) {
    describe(row.role, () => {
      it.each(row.hits)('resolves from %s', (_name, source, i, expected) => {
        const { roles } = run(i);
        expect(text(roles, row.role)).toBe(expected);
        expect(roles[row.role]?.source).toBe(source);
        expect(roles[row.role]?.kind).toBe(ROLE_KINDS[row.role]);
      });
      it.each(row.misses)('is absent: %s', (_name, i) => {
        const { roles } = run(i);
        if (row.role === 'title') expect(text(roles, 'title')).toBe('Acme');
        else expect(roles[row.role]).toBeUndefined();
      });
    });
  }
});

describe('role resolution order', () => {
  const both = withSemantics(
    'eventTicket',
    { eventName: 'From semantics' },
    { fields: ALL_FIELDS },
  );

  it('manifest beats semantics beats the style default', () => {
    expect(run(both).roles.eventName).toMatchObject({
      source: 'semantics',
      text: 'From semantics',
    });
    expect(run(input('eventTicket', { fields: ALL_FIELDS })).roles.eventName).toMatchObject({
      source: 'style',
    });
    expect(
      run(both, { eventName: { value: 'x' } }, () => 'From manifest').roles.eventName,
    ).toMatchObject({
      source: 'manifest',
      text: 'From manifest',
    });
  });

  it('reads the pass semantics before field semantics, and a field supplies its label', () => {
    const fieldOnly = input('generic', {
      fields: [onField('primary', { eventName: 'On field' }, 'Show')],
    });
    expect(run(fieldOnly).roles.eventName).toMatchObject({
      source: 'semantics',
      text: 'On field',
      label: 'Show',
      fields: [fieldPath('primary', 'f')],
    });
    const rootToo = { ...fieldOnly, semantics: { eventName: 'On pass' } };
    expect(run(rootToo).roles.eventName).toMatchObject({ text: 'On pass', fields: [] });
  });

  it('reads a manifest field by key, with its label and path', () => {
    const i = input('generic', { fields: [field('back', 'pts', 12, { label: 'Points' })] });
    expect(run(i, { points: { field: 'pts' } }).roles.points).toEqual({
      kind: 'number',
      number: 12,
      text: '12',
      source: 'manifest',
      label: 'Points',
      fields: [fieldPath('back', 'pts')],
    });
  });

  it('types manifest values by role', () => {
    const roles = (m: Partial<Record<WalletRole, WalletRoleSource>>, value: unknown) =>
      run(bare, m, () => value as never).roles;
    expect(roles({ points: { value: 'x' } }, 'Gold tier').points).toMatchObject({
      kind: 'text',
      text: 'Gold tier',
    });
    expect(roles({ balance: { value: 'x' } }, '12.50 eur').balance).toMatchObject({
      kind: 'money',
      amount: '12.50',
      currencyCode: 'EUR',
    });
    expect(
      roles({ balance: { value: 'x' } }, { amount: '3', currencyCode: 'USD' }).balance,
    ).toMatchObject({ kind: 'money', amount: '3' });
    expect(roles({ venueLocation: { value: 'x' } }, '59.9, 10.7').venueLocation).toMatchObject({
      latitude: 59.9,
      longitude: 10.7,
    });
    expect(roles({ redemptionChannel: { value: 'x' } }, 'online').redemptionChannel).toMatchObject({
      channel: 'online',
    });
    expect(
      roles({ support: { value: 'x' } }, ['tel:+47', 'https://a.example']).support,
    ).toMatchObject({ kind: 'links' });
    expect(roles({ appLink: { value: 'x' } }, 'https://a.example').appLink).toMatchObject({
      kind: 'app',
      url: 'https://a.example',
    });
  });

  it.each([
    ['eventStart', 'someday'],
    ['venueLocation', '200, 10'],
    ['balance', 'lots'],
    ['redemptionChannel', 'mail'],
    ['support', 'ftp://x'],
    ['appLink', 'http://insecure.example'],
  ] as const)('a manifest %s of %s is absent and noted, with no fallback', (role, value) => {
    const i = withSemantics(
      'coupon',
      { eventStartDate: '2030-01-01T00:00:00Z' },
      { fields: ALL_FIELDS },
    );
    const { roles, notes } = run(i, { [role]: { value: 'x' } }, () => value);
    expect(roles[role]).toBeUndefined();
    expect(notes).toEqual([expect.objectContaining({ code: 'ROLE_VALUE_INVALID', subject: role })]);
  });

  it('false removes a role, and the title still exists', () => {
    const i = withSemantics('eventTicket', { eventName: 'Gig' }, { fields: ALL_FIELDS });
    const { roles, notes } = run(i, { eventName: false, title: false });
    expect(roles.eventName).toBeUndefined();
    expect(text(roles, 'title')).toBe('Acme');
    expect(notes).toEqual([]);
  });

  it('notes a failing expression, an empty value and a missing field', () => {
    const { roles, notes } = resolveRoles(
      bare,
      { tier: { value: 'a' }, points: { value: 'b' }, memberId: { field: 'ghost' } },
      (expr) => {
        if (expr === 'a') throw new Error('boom');
        return '';
      },
    );
    expect(roles.tier).toBeUndefined();
    expect(notes.map((n) => `${n.code}:${n.subject}`)).toEqual([
      'ROLE_FIELD_MISSING:memberId',
      'ROLE_EXPR_FAILED:tier',
      'ROLE_EMPTY:points',
    ]);
  });

  it('never guesses from field keys or labels', () => {
    const i = input('storeCard', {
      fields: [
        field('primary', 'points', 40, { label: 'Points' }),
        field('secondary', 'tier', 'Gold', { label: 'Tier' }),
      ],
    });
    const { roles } = run(i);
    expect(roles.points).toBeUndefined();
    expect(roles.tier).toBeUndefined();
  });
});
