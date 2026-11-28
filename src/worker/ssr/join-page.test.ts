import { describe, expect, it } from 'vitest';
import { JOIN_COPY } from '../../shared/copy/join.ts';
import type { DeviceInfo } from '../../shared/device.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { contentSecurityPolicy } from '../platform/security-headers.ts';
import { type JoinPage, type Refusal, renderJoinPage, statusOf } from './join-page.tsx';

// The server deletes the barcodes before it normalizes; so does the fixture.
const { barcode: _b, barcodes: _bs, ...noCode } = fixtures.generic;
const card = normalize(noCode, {
  assets,
  now: new Date('2026-10-31T12:00:00Z'),
  timeZone: 'UTC',
});

const IPHONE: DeviceInfo = { device: 'iphone', inApp: false };
const IPHONE_APP: DeviceInfo = { device: 'iphone', inApp: true };
const ANDROID: DeviceInfo = { device: 'other', inApp: false };
const DESKTOP: DeviceInfo = { device: 'mac', inApp: false };

const form = (over: Partial<Extract<JoinPage, { kind: 'form' }>> = {}): JoinPage => ({
  kind: 'form',
  orgName: 'Dos Olas',
  askName: true,
  askEmail: false,
  test: false,
  card,
  siteKey: '1x00000000000000000000AA',
  device: IPHONE,
  ...over,
});

const refused = (reason: Refusal): JoinPage => ({ kind: 'refused', reason });
const NONCE = 'n0nce';
const render = (page: JoinPage, theme?: 'light' | 'dark') => renderJoinPage(page, NONCE, theme);
/** The markup without the inlined sheets, so a snapshot shows what the page says. */
const markup = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '<style/>')
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>');

const STATES: Record<string, JoinPage> = {
  form: form(),
  'form with email': form({ askEmail: true }),
  'form, name error': form({ error: 'Enter your first name.', values: { name: '', email: '' } }),
  'form, email error': form({
    askEmail: true,
    error: 'Enter a valid email.',
    values: { name: 'Ana', email: 'ana@' },
  }),
  'form, verification failed': form({
    error: JOIN_COPY.refusal.turnstile,
    values: { name: 'Ana', email: '' },
  }),
  'form, test link': form({ test: true }),
  'form, no card': form({ card: null }),
  'form, in-app browser': form({ device: IPHONE_APP }),
  'check email': { kind: 'check_email', orgName: 'Dos Olas', email: 'ana@example.com' },
  'device limit': refused('device_limit'),
  'too many tries': refused('too_many'),
  'daily limit': refused('daily_limit'),
  closed: refused('closed'),
  expired: refused('expired'),
};

describe('join page states', () => {
  for (const [name, page] of Object.entries(STATES)) {
    it(`renders ${name}`, () => {
      const html = render(page);
      expect(markup(html)).toMatchSnapshot();
      expect(html).not.toMatch(/\{[a-z]+\}/);
      expect(html).toContain(`<style nonce="${NONCE}">`);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    });
  }

  it('answers each state with the design status', () => {
    const status = Object.fromEntries(
      Object.entries(STATES).map(([name, page]) => [name, statusOf(page)]),
    );
    expect(status).toMatchObject({
      form: 200,
      'form, name error': 422,
      'check email': 200,
      'device limit': 429,
      'too many tries': 429,
      'daily limit': 429,
      closed: 200,
      expired: 404,
    });
  });

  it('says each refusal in its own words', () => {
    const lines = {
      device_limit: JOIN_COPY.refusal.deviceLimit,
      too_many: JOIN_COPY.refusal.tooManyTries,
      daily_limit: JOIN_COPY.refusal.dailyLimit,
      closed: JOIN_COPY.refusal.closed,
      expired: JOIN_COPY.refusal.expired,
    } as const;
    for (const [reason, line] of Object.entries(lines)) {
      const html = render(refused(reason as Refusal));
      for (const part of line.split('. ')) expect(html).toContain(part.replace(/\.$/, ''));
    }
  });
});

describe('join page form', () => {
  it('posts as a plain form to its own address, with the check field and the widget host', () => {
    const html = render(form());
    expect(html).toMatch(/<form class="jn-form"[^>]*method="post"/);
    expect(html).toMatch(/<form[^>]*action=""/);
    expect(html).toContain('data-sitekey="1x00000000000000000000AA"');
    expect(html).toContain('name="cf-turnstile-response"');
    expect(html).toMatch(/autocomplete="given-name"/i);
    expect(html).toContain('<script src="/join.js" defer></script>');
  });

  it('asks only for what the link asks', () => {
    const name = render(form());
    expect(name).toContain('name="name"');
    expect(name).not.toContain('name="email"');
    const both = render(form({ askEmail: true }));
    expect(both).toContain('type="email"');
    expect(both).toMatch(/autocomplete="email"/i);
    expect(both).not.toContain('keeps your name');
  });

  it('leads with the org and puts the buddy on the card', () => {
    const html = render(form());
    expect(html).toContain('Get your Dos Olas card');
    expect(html).toMatch(/<div class="jn-host"[^>]*><span[^>]*data-buddy/);
    expect(html).toContain('data-part="c2"');
  });

  it('draws no barcode, back or pass link in the preview', () => {
    const html = render(form());
    expect(html).not.toContain('/p/');
    expect(html).not.toContain('pass.pkpass');
    expect(html).not.toContain('pc-barcode');
  });

  it('shows the test strip only on a test link', () => {
    expect(render(form({ test: true }))).toContain(JOIN_COPY.page.testStrip);
    expect(render(form())).not.toContain(JOIN_COPY.page.testStrip);
  });

  it('escapes the org name, the typed values and the error', () => {
    const html = render(
      form({
        orgName: '<img src=x onerror=alert(1)>',
        askEmail: true,
        values: { name: '"><script>x</script>', email: '"><b>' },
        error: '<b>bad</b>',
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<b>bad');
  });

  it('stamps the theme and follows the OS without one', () => {
    expect(render(form(), 'dark')).toContain('<html lang="en" data-theme="dark">');
    expect(render(form(), 'light')).toContain('data-theme="light"');
    expect(render(form())).not.toContain('data-theme');
  });
});

describe('in-app browsers', () => {
  const LINE = JOIN_COPY.page.inApp;
  it('says to open Safari, with Copy link, only in an app web view', () => {
    const app = render(form({ device: IPHONE_APP }));
    expect(app).toContain(LINE);
    expect(app).toContain('data-copy=""');
    expect(app).toContain(`>${JOIN_COPY.page.copyLink}</button>`);
    expect(app).toContain(`data-copied="${JOIN_COPY.toast.copied}"`);
    for (const device of [IPHONE, ANDROID, DESKTOP]) {
      const html = render(form({ device }));
      expect(html).not.toContain(LINE);
      expect(html).not.toContain('data-copy');
    }
  });

  it('keeps the form working in the app', () => {
    const app = render(form({ device: IPHONE_APP }));
    expect(app).toContain('data-join=""');
    expect(app.indexOf(LINE)).toBeLessThan(app.indexOf('<form'));
  });
});

describe('CSP and the nonce', () => {
  it('allows Turnstile on the join page only, with a nonce for the one style block', () => {
    const csp = contentSecurityPolicy(NONCE, { turnstile: true });
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).toContain("script-src 'self' 'nonce-n0nce' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(contentSecurityPolicy(NONCE)).not.toContain('challenges.cloudflare.com');
  });

  it('carries no inline script and no inline handler: only same-origin script files', () => {
    for (const page of Object.values(STATES)) {
      const html = render(page);
      const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      for (const tag of tags) expect(tag).toMatch(/src="\/[a-z-]+\.js"/);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toContain('javascript:');
    }
  });

  it('puts the nonce on every inline style block', () => {
    for (const page of Object.values(STATES)) {
      const blocks = [...render(page).matchAll(/<style\b[^>]*>/g)].map((m) => m[0]);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).toBe(`<style nonce="${NONCE}">`);
    }
  });
});
