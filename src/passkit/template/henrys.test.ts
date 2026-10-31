import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PassBuildError } from '../build.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { PassField, Personalization, SigningMaterial } from '../types.ts';
import { buildBaked as build, freezeNow, loadBaked, stableJson } from './baked-fixtures.ts';

vi.mock('../validate.ts', async (importOriginal) =>
  (await import('./validator-shim.ts')).shimValidator(
    await importOriginal<typeof import('../validate.ts')>(),
  ),
);

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
});

const member: Personalization = {
  memberName: 'Alex Morgan',
  memberId: 'DEMO0001',
  membership: 'All-Inclusive Wellness',
};
const scenarios = {
  'capitol-hill-home': { ...member, homeClub: 'capitol-hill', access: 'home' },
  'queen-anne-home': { ...member, homeClub: 'queen-anne', access: 'home' },
  'capitol-hill-all': { ...member, homeClub: 'capitol-hill', access: 'all' },
  'queen-anne-all': { ...member, homeClub: 'queen-anne', access: 'all' },
} satisfies Record<string, Personalization>;

const keys = (fields?: unknown) => ((fields as PassField[] | undefined) ?? []).map((f) => f.key);

describe.each(['henrys-copper', 'henrys-blue'])('%s', (slug) => {
  describe.each(Object.entries(scenarios))('%s', (name, input) => {
    it('matches the golden pass.json', async () => {
      const built = await build(slug, material, input);
      await expect(stableJson(built.passJson)).toMatchFileSnapshot(
        `__snapshots__/${slug}.${name}.golden`,
      );
    });
  });

  it('places one location per eligible club at the entrance with short relevant text', async () => {
    const home = (await build(slug, material, scenarios['queen-anne-home'])).passJson;
    expect(home.locations).toEqual([
      {
        latitude: 47.624765,
        longitude: -122.356206,
        relevantText: 'Queen Anne club · 14 Mercer St',
      },
    ]);
    const all = (await build(slug, material, scenarios['queen-anne-all'])).passJson;
    expect(all.locations).toEqual([
      {
        latitude: 47.615835,
        longitude: -122.323555,
        relevantText: 'Capitol Hill club · 1617 Boylston Ave',
      },
      {
        latitude: 47.624765,
        longitude: -122.356206,
        relevantText: 'Queen Anne club · 14 Mercer St',
      },
    ]);
    for (const pass of [home, all]) {
      expect(pass.maxDistance).toBeUndefined();
      expect(pass.relevantDate).toBeUndefined();
      expect(pass.relevantDates).toBeUndefined();
      expect(JSON.stringify(pass.locations)).not.toContain('Henry');
    }
  });

  it('points the home-club action at the home club and keeps the portal action', async () => {
    const ch = (await build(slug, material, scenarios['capitol-hill-home'])).passJson;
    const qa = (await build(slug, material, scenarios['queen-anne-all'])).passJson;
    expect(ch.featuredActions).toEqual([
      {
        identifier: 'member-portal',
        type: 'membershipBenefits',
        url: expect.stringContaining('https://'),
      },
      { identifier: 'home-club', type: 'place', placeIdentifier: 'I23C636C7300F20FD' },
    ]);
    expect(qa.featuredActions).toContainEqual({
      identifier: 'home-club',
      type: 'place',
      placeIdentifier: 'I1F4F79088B704BE',
    });
  });

  it('shows directions only for eligible clubs and the home club phone', async () => {
    const home = (await build(slug, material, scenarios['queen-anne-home'])).passJson;
    expect(keys(home.generic?.backFields).filter((k) => k.startsWith('directions-'))).toEqual([
      'directions-queen-anne',
    ]);
    expect(keys(home.posterGeneric?.backFields).filter((k) => k.startsWith('directions-'))).toEqual(
      ['directions-queen-anne-poster'],
    );
    const phone = home.generic?.backFields?.find((f) => f.key === 'phone');
    expect(phone).toMatchObject({
      value: '(206) 644-0969',
      attributedValue: '<a href="tel:+12066440969">(206) 644-0969</a>',
    });
    const all = (await build(slug, material, scenarios['capitol-hill-all'])).passJson;
    expect(keys(all.generic?.backFields).filter((k) => k.startsWith('directions-'))).toEqual([
      'directions-capitol-hill',
      'directions-queen-anne',
    ]);
  });

  it('has unique field keys across the whole pass', async () => {
    const pass = (await build(slug, material, scenarios['capitol-hill-all'])).passJson;
    const all = [pass.generic, pass.posterGeneric].flatMap((dict) =>
      Object.values(dict ?? {}).flatMap((v) => (Array.isArray(v) ? keys(v) : [])),
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('uses posterGeneric with a generic fallback and Code 39 then Code 128', async () => {
    const pass = (await build(slug, material)).passJson;
    expect(pass.preferredStyleSchemes).toEqual(['posterGeneric', 'generic']);
    expect(pass.sharingProhibited).toBe(true);
    expect(pass.barcodes?.map((b) => b.format)).toEqual([
      'PKBarcodeFormatCode39',
      'PKBarcodeFormatCode128',
    ]);
    expect(pass.barcodes?.every((b) => b.altText === 'DEMO0001' && b.message === 'DEMO0001')).toBe(
      true,
    );
  });

  it('puts changeMessage on status, membership and home club, never on linked fields', async () => {
    const pass = (await build(slug, material)).passJson;
    const fields = [pass.generic, pass.posterGeneric].flatMap((dict) =>
      Object.values(dict ?? {}).flatMap((v) => (Array.isArray(v) ? (v as PassField[]) : [])),
    );
    const withMessage = fields.filter((f) => f.changeMessage).map((f) => f.key);
    expect(withMessage).toEqual(
      expect.arrayContaining(['status', 'membership', 'homeClub', 'status-poster']),
    );
    expect(fields.filter((f) => f.changeMessage && f.attributedValue)).toEqual([]);
    for (const f of fields.filter((f) => f.changeMessage)) expect(f.changeMessage).toContain('%@');
  });

  it('binds expiry and voided from input, and omits expiry when absent', async () => {
    const plain = (await build(slug, material)).passJson;
    expect(plain.expirationDate).toBeUndefined();
    expect(plain.voided).toBe(false);
    const ended = (
      await build(slug, material, {
        ...member,
        expirationDate: '2027-01-31T23:59:00-08:00',
        voided: true,
        status: 'Cancelled',
      })
    ).passJson;
    expect(ended.expirationDate).toBe('2027-01-31T23:59:00-08:00');
    expect(ended.voided).toBe(true);
    expect(ended.generic?.headerFields?.[0]?.value).toBe('Cancelled');
  });

  it('escapes the portal link in attributed text and rejects non-https links', async () => {
    const pass = (
      await build(slug, material, { ...member, memberPortalURL: 'https://x.test/?a=b&c=d' })
    ).passJson;
    const portal = pass.generic?.backFields?.find((f) => f.key === 'portal');
    expect(portal?.attributedValue).toBe('<a href="https://x.test/?a=b&amp;c=d">Member portal</a>');
    for (const memberPortalURL of [
      'javascript:alert(1)',
      'http://x.test',
      'https://x.test/"><b>',
    ]) {
      const error = await build(slug, material, { ...member, memberPortalURL }).catch(
        (e: unknown) => e,
      );
      expect((error as PassBuildError).code, memberPortalURL).toBe('INVALID_INPUT');
    }
  });

  it('rejects ids outside the Code 39 set, unknown clubs and unknown access', async () => {
    const invalid: Personalization[] = [
      { memberId: 'abc' },
      { memberId: 'A*B' },
      { homeClub: 'Capitol Hill' },
      { access: 'All clubs' },
      { status: 'Paused' },
      { expirationDate: 'tomorrow' },
    ];
    for (const bad of invalid) {
      const error = await build(slug, material, { ...member, ...bad }).catch((e: unknown) => e);
      expect((error as PassBuildError).code, JSON.stringify(bad)).toBe('INVALID_INPUT');
    }
  });

  it('drops the empty message field instead of shipping blanks', async () => {
    const pass = (await build(slug, material, { ...member, message: '' })).passJson;
    expect(keys(pass.generic?.backFields)).not.toContain('message');
    expect(keys(pass.posterGeneric?.backFields)).not.toContain('message-poster');
  });

  it('keeps background art out of the signed bundle but available for preview', async () => {
    const { template } = await loadBaked(slug);
    expect(template.assets.map((a) => a.name)).toContain('background.png');
    const built = await build(slug, material);
    expect(Object.keys(built.signed.files).filter((n) => n.startsWith('background'))).toEqual([]);
    expect(Object.keys(built.signed.files)).toEqual(
      expect.arrayContaining([
        'artwork@3x.png',
        'primaryLogo.png',
        'logo.png',
        'en.lproj/pass.strings',
      ]),
    );
  });

  it('ships the en strings scaffold covering every label and change message', async () => {
    const { pkg } = await loadBaked(slug);
    const strings = new TextDecoder().decode(pkg.bytes['en.lproj/pass.strings']);
    expect(strings).toContain('"MEMBER NUMBER" = "MEMBER NUMBER";');
    expect(strings).toContain(
      '"Your membership status is now %@." = "Your membership status is now %@.";',
    );
    expect(strings).toContain('"FROM HENRY\\U2019S" = "FROM HENRY\\U2019S";');
  });

  it('keeps image dimensions at the catalog sizes', async () => {
    const { pkg } = await loadBaked(slug);
    const size = (n: string) => {
      const a = pkg.assets.find((x) => x.name === n);
      return a ? [a.width, a.height] : null;
    };
    expect(size('artwork.png')).toEqual([358, 448]);
    expect(size('artwork@3x.png')).toEqual([1074, 1344]);
    expect(size('primaryLogo@2x.png')).toEqual([252, 60]);
    expect(size('icon@3x.png')).toEqual([114, 114]);
  });
});
