import { describe, expect, it } from 'vitest';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { emailBrandOf } from '../email/brand.ts';
import { renderBundleEmail } from '../email/bundle.ts';
import { renderPassEmail } from '../email/pass.ts';
import { emailShell } from '../email/shell.ts';
import { renderBundlePage } from './bundle-page.tsx';
import { renderErrorPage } from './error-page.tsx';
import { hostedPage } from './hosted.ts';
import { renderJoinPage } from './join-page.tsx';
import { brandCss } from './org-brand-css.ts';
import { renderPassPage } from './pass-page.tsx';
import { renderPresentationPage } from './presentation-page.tsx';
import { renderPrintPage } from './print-page.tsx';

const SHA = 'a'.repeat(64);
const brand = (over: Partial<OrgBrand> = {}): OrgBrand => ({
  orgId: 'org-1',
  name: 'Northwind <b>',
  accent: '#b4232c',
  logo: { path: `/brand/org-1/${SHA}.png`, w: 400, h: 100 },
  supportEmail: null,
  supportUrl: null,
  mark: 'full',
  ...over,
});
const none = brand({ mark: 'none' });
const small = brand({ mark: 'small' });
const bare = brand({ logo: null, accent: null });

const pass = (b: OrgBrand | undefined) =>
  renderPassPage({
    view: normalize(
      { ...fixtures.generic },
      { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
    ),
    passJson: { ...fixtures.generic },
    now: new Date('2026-10-31T12:00:00Z'),
    nonce: 'n',
    orgName: 'Gym',
    orgLabel: 'Gym',
    passTitle: 'Membership',
    downloadHref: '/p/t/pass.pkpass',
    walletOffers: [],
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'other', inApp: false },
    ...(b ? { brand: b } : {}),
  });
const bundle = (b: OrgBrand) =>
  renderBundlePage({
    nonce: 'n',
    orgName: 'Gym',
    orgLabel: 'Gym',
    brand: b,
    name: 'Trip',
    items: [],
    addAllHref: '/b/t/passes.pkpasses',
    publicUrl: 'https://w.test/b/t',
    device: { device: 'iphone', inApp: false },
  });
const join = (b: OrgBrand) =>
  renderJoinPage(
    { kind: 'form', orgName: 'Gym', brand: b, askName: true, askEmail: true, test: false },
    'n',
  );
const checkEmail = (b: OrgBrand) =>
  renderJoinPage({ kind: 'check_email', orgName: 'Gym', email: 'a@b.test', brand: b }, 'n');
const error = (b: OrgBrand) => renderErrorPage({ status: 404, nonce: 'n', brand: b });
const presentation = (b: OrgBrand) =>
  renderPresentationPage({
    barcode: null,
    orgName: 'Gym',
    brand: b,
    passTitle: 'Pass',
    mode: 'live',
    backHref: '/p/t',
    nonce: 'n',
  });
const print = (b: OrgBrand) =>
  renderPrintPage({
    model: { state: 'unavailable', orgName: 'Gym', mode: 'live' },
    audience: 'holder',
    nonce: 'n',
    brand: b,
  });

/** Every holder surface that draws the org's shell, by name. */
const SURFACES = {
  pass,
  bundle,
  join,
  'join check email': checkEmail,
  error,
  presentation,
  print,
} as const;

describe.each(Object.entries(SURFACES))('org shell on %s', (_name, render) => {
  it('leads with the same-origin web logo, escaped, never the platform wordmark', () => {
    const html = render(brand());
    expect(html).toContain(`src="/brand/org-1/${SHA}.png"`);
    expect(html).toContain('alt="Northwind &lt;b&gt;"');
    expect(html).not.toContain('Northwind <b>');
    expect(html).not.toMatch(/src="https?:/);
  });

  it('draws the mark per level: full wordmark, one small line, nothing', () => {
    expect(render(brand())).toContain('Issued with');
    expect(render(small)).toContain('Powered by PassBook');
    expect(render(small)).not.toContain('Issued with');
    const off = render(none);
    expect(off).not.toContain('Issued with');
    expect(off).not.toContain('Powered by PassBook');
  });

  it('puts the accent in the page as tokens, from a validated hex only', () => {
    expect(render(brand())).toContain('--pk-accent:#b4232c');
    expect(render(bare)).not.toContain('--pk-accent:#b4232c');
  });
});

describe('org shell without a logo', () => {
  it('names the org in the band, not PassBook', () => {
    const html = hostedPage({
      nonce: 'n',
      title: 'Hello',
      art: 'confirm',
      body: '',
      brand: bare,
    });
    expect(html).toContain('<span class="org-name">Northwind &lt;b&gt;</span>');
    expect(html).toContain('<title>Hello · Northwind &lt;b&gt;</title>');
    expect(html).not.toContain('class="mark"');
  });

  it('keeps the platform shell when no org is given', () => {
    const html = hostedPage({ nonce: 'n', title: 'Hello', art: 'confirm', body: '' });
    expect(html).toContain('class="mark"');
    expect(html).not.toContain('org-mark');
  });
});

describe('accent', () => {
  it('uses white or black text, whichever reads on the accent', () => {
    expect(brandCss({ accent: '#ffeb3b' })).toContain('--pk-accent-on:#000000');
    expect(brandCss({ accent: '#1b3a8c' })).toContain('--pk-accent-on:#ffffff');
  });

  it('leaves a colour that vanishes on dark pages off there', () => {
    const css = brandCss({ accent: '#10131c' });
    const dark = css.split('[data-theme="dark"]')[1] ?? '';
    expect(dark).toContain('--pk-accent:#2dd4bf');
    expect(css).toContain('--pk-accent:#10131c');
  });

  it('ignores anything that is not a six digit hex', () => {
    expect(brandCss({ accent: 'red; } body { display:none' })).toBe('');
    expect(brandCss({ accent: null })).toBe('');
  });
});

describe('email band', () => {
  const env = { PUBLIC_BASE_URL: 'https://passbook.test/' };
  const shell = (b: OrgBrand) =>
    emailShell({ lang: 'en', title: 'T', header: 'Gym', body: 'x', brand: emailBrandOf(env, b) });

  it('draws the web logo by absolute URL at band size, named by its alt', () => {
    const html = shell(brand());
    expect(html).toContain(`src="https://passbook.test/brand/org-1/${SHA}.png"`);
    expect(html).toContain('width="128" height="32"');
    expect(html).toContain('alt="Gym"');
  });

  it('ends the card with the mark line for its level', () => {
    expect(shell(brand())).toContain('Issued with <b>PassBook</b>');
    expect(shell(small)).toContain('Powered by PassBook');
    expect(shell(none)).not.toMatch(/Issued with|Powered by/);
  });

  it('falls back to the name when there is no logo', () => {
    const html = shell(bare);
    expect(html).not.toContain('/brand/');
    expect(html).toContain('Gym');
  });
});

describe('pass and bundle emails', () => {
  const env = { PUBLIC_BASE_URL: 'https://passbook.test' };
  const pass = (b: OrgBrand) =>
    renderPassEmail({
      orgName: 'Gym',
      downloadUrl: null,
      manageUrl: 'https://passbook.test/p/t',
      badgeUrl: 'https://passbook.test/b.png',
      attached: false,
      brand: emailBrandOf(env, b),
    });
  const bundle = (b: OrgBrand) =>
    renderBundleEmail({
      orgName: 'Gym',
      bundleName: 'Trip',
      pageUrl: 'https://passbook.test/b/t',
      addAllUrl: null,
      badgeUrl: 'https://passbook.test/b.png',
      passes: [],
      brand: emailBrandOf(env, b),
    });

  it('carry the logo in the band and the mark in html and text', () => {
    for (const render of [pass, bundle]) {
      const full = render(brand());
      expect(full.html).toContain(`https://passbook.test/brand/org-1/${SHA}.png`);
      expect(full.text).toContain('Issued with PassBook');
      expect(render(small).text).toContain('Powered by PassBook');
      const off = render(none);
      expect(off.html).not.toMatch(/Issued with|Powered by/);
      expect(off.text).not.toMatch(/Issued with|Powered by/);
    }
  });
});
