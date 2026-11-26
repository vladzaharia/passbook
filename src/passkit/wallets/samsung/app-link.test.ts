import { beforeAll, describe, expect, it } from 'vitest';
import { loadBaked } from '../../template/baked-fixtures.ts';
import type { WalletPassView } from '../types.ts';
import { APP, attributes, compile, view } from './fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

describe('appLink defaults (Q22)', () => {
  it('uses the org logo, name and website from settings', async () => {
    const a = attributes(compile(await view('starter-coupon')));
    expect(a).toMatchObject({
      appLinkLogo: APP.logo,
      appLinkName: APP.name,
      appLinkData: APP.url,
    });
  });

  it('falls back to the template logo and organization name, with the portal URL as the address', async () => {
    const v = await view('starter-coupon', { appLink: null });
    const a = attributes(compile(v, { portalUrl: 'https://portal.example/sign-in' }));
    expect(a).toMatchObject({
      appLinkLogo: 'https://img.example/logo@3x.png',
      appLinkName: v.org,
      appLinkData: 'https://portal.example/sign-in',
    });
  });

  it('prefers the website over the portal URL', async () => {
    const a = attributes(
      compile(await view('starter-coupon'), { portalUrl: 'https://portal.example' }),
    );
    expect(a.appLinkData).toBe(APP.url);
  });

  it('keeps the logo and name defaults when the author sets only an address', async () => {
    const v = await view('starter-coupon', {
      wallets: { schema: 1, roles: { appLink: { value: 'https://author.example/app' } } },
    });
    expect(attributes(compile(v))).toMatchObject({
      appLinkData: 'https://author.example/app',
      appLinkName: v.org,
      appLinkLogo: 'https://img.example/logo@3x.png',
    });
  });

  it('blocks when there is no address at all, naming what is missing', async () => {
    const r = compile(await view('starter-coupon', { appLink: null }));
    expect(r.blocked).toMatchObject({ code: 'REQUIRED_ROLE_EMPTY' });
    expect(r.blocked?.message).toContain('an address');
    expect(r.cardData).toBeUndefined();
  });

  it('blocks when there is no logo', async () => {
    const v = await view('starter-coupon', { appLink: { ...APP, logo: '' } });
    const noLogo: WalletPassView = { ...v, images: { ...v.images, apple: {} } };
    expect(compile(noLogo).blocked?.message).toContain('a logo');
  });

  it('never cuts an address: one over 256 bytes blocks the pass', async () => {
    const v = await view('starter-coupon', {
      appLink: { ...APP, url: `https://org.example/${'p'.repeat(260)}` },
    });
    expect(compile(v).blocked?.code).toBe('IDENTITY_TOO_LONG');
  });

  it('writes the required attributes on every type', async () => {
    for (const slug of ['starter-coupon', 'starter-event-ticket', 'starter-store-card'])
      expect(Object.keys(attributes(compile(await view(slug))))).toEqual(
        expect.arrayContaining(['appLinkLogo', 'appLinkName', 'appLinkData']),
      );
  });
});

describe('personal images never go to Samsung (Q18)', () => {
  const PERSONAL = 'https://img.example/member-photo.png';

  it('skips a personal file even when it carries a URL, and reports it', async () => {
    const v = await view('starter-store-card');
    v.images.apple.strip = [
      { name: 'strip@2x.png', slot: 'strip', scale: 2, personal: true, url: PERSONAL },
    ];
    v.images.apple.thumbnail = [
      { name: 'thumbnail@2x.png', slot: 'thumbnail', scale: 2, personal: true, url: PERSONAL },
    ];
    const r = compile(v);
    expect(JSON.stringify(r)).not.toContain(PERSONAL);
    expect(r.items).toContainEqual(
      expect.objectContaining({ capability: 'image.personal', support: 'omitted', path: 'strip' }),
    );
    expect(attributes(r).bgImage).toBeUndefined();
  });

  it('skips a personal logo and uses the next template logo', async () => {
    const v = await view('starter-store-card');
    v.images.apple.logo = [
      { name: 'logo.png', slot: 'logo', scale: 2, personal: true, url: PERSONAL },
    ];
    v.images.apple.primaryLogo = [
      {
        name: 'primaryLogo@2x.png',
        slot: 'primaryLogo',
        scale: 2,
        personal: false,
        url: 'https://img.example/p.png',
      },
    ];
    const r = compile(v);
    expect(attributes(r).logoImage).toBe('https://img.example/p.png');
    expect(JSON.stringify(r)).not.toContain(PERSONAL);
  });

  it('sends a template image only when it has a public URL', async () => {
    const v = await view('starter-store-card');
    v.images.apple.strip = [{ name: 'strip@2x.png', slot: 'strip', scale: 2, personal: false }];
    const r = compile(v);
    expect(attributes(r).bgImage).toBeUndefined();
    expect(r.items).toContainEqual(
      expect.objectContaining({
        capability: 'image.strip',
        support: 'omitted',
        message: 'The image has no public address.',
      }),
    );
  });

  it('says a strip of the wrong size is the problem, not its address', async () => {
    const v = await view('starter-store-card');
    v.images.apple.strip = [
      { name: 'strip@2x.png', slot: 'strip', scale: 2, personal: false, width: 1125, height: 432 },
    ];
    const r = compile(v);
    expect(attributes(r).bgImage).toBeUndefined();
    expect(r.items).toContainEqual(
      expect.objectContaining({
        capability: 'image.strip',
        support: 'omitted',
        message:
          'The strip (background) image is 1125 x 432; Samsung needs 888 x 555 (888:555). Replace it.',
      }),
    );
  });
});
