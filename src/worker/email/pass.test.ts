import { describe, expect, it } from 'vitest';
import { EMAIL_BADGE, EMAIL_BUDDY, PASS_EMAIL_MOOD } from '../../shared/email-art.ts';
import { ADD_LINE, renderPassEmail } from './pass.ts';
import { passSummary } from './pass-summary.ts';
import { EMAIL_LIGHT, RADIUS } from './shell.ts';
import { renderSignInEmail } from './sign-in.ts';

const ICON = 'https://w.test/p/t/assets/icon@3x.png?v=1';

const PASS_JSON = {
  description: 'Harbor Lights Festival event ticket',
  backgroundColor: 'rgb(40, 30, 120)',
  foregroundColor: 'rgb(255, 255, 255)',
  labelColor: 'rgb(200, 200, 255)',
  eventTicket: {
    primaryFields: [{ key: 'event', label: 'Event', value: 'Harbor Lights 2026' }],
    secondaryFields: [
      { key: 'venue', label: 'Venue', value: 'Pier 62' },
      { key: 'date', label: 'Date', value: '2026-11-16T18:00:00Z', dateStyle: 'PKDateStyleMedium' },
    ],
    auxiliaryFields: [{ key: 'seat', label: 'Seat', value: 'Row A, seat 4' }],
  },
};

const render = (over: Partial<Parameters<typeof renderPassEmail>[0]> = {}) =>
  renderPassEmail({
    orgName: 'Harbor Lights Festival',
    downloadUrl: 'https://w.test/p/t/pass.pkpass',
    manageUrl: 'https://w.test/p/t',
    badgeUrl: 'https://w.test/apple/badge/en/black@2x.png',
    attached: false,
    passTitle: 'Harbor Lights 2026',
    summary: passSummary(PASS_JSON, { now: new Date('2026-11-01T00:00:00Z'), timeZone: 'UTC' }),
    senderName: 'PassBook',
    ...over,
  });

describe('passSummary', () => {
  it('takes the front fields, formatted, in the pass colours', () => {
    const s = passSummary(PASS_JSON, { now: new Date('2026-11-01T00:00:00Z'), timeZone: 'UTC' });
    expect(s.fields).toHaveLength(4);
    expect(s.fields[2]).toEqual({ label: 'Date', value: 'Nov 16, 2026' });
    expect(s.colors.background).toBe('rgb(40, 30, 120)');
  });

  it('leads with the header date and start time on tickets and boarding passes', () => {
    const header = [
      { key: 'date', label: 'Date', value: '2026-11-16T18:00:00Z', dateStyle: 'PKDateStyleMedium' },
    ];
    const ctx = { now: new Date('2026-11-01T00:00:00Z'), timeZone: 'UTC' };
    const event = passSummary(
      {
        eventTicket: {
          headerFields: header,
          primaryFields: [{ key: 'e', label: 'Event', value: 'Harbor Lights 2026' }],
          secondaryFields: [
            {
              key: 't',
              label: 'Starts',
              value: '2026-11-16T18:00:00Z',
              dateStyle: 'PKDateStyleNone',
              timeStyle: 'PKDateStyleShort',
            },
            { key: 'v', label: 'Venue', value: 'Pier 62' },
          ],
        },
      },
      ctx,
    );
    expect(event.fields.map((f) => f.label)).toEqual(['Date', 'Event', 'Starts', 'Venue']);
    expect(event.fields[0]?.value).toBe('Nov 16, 2026');
    expect(event.fields[2]?.value).toBe('6:00 PM');
    const store = passSummary(
      {
        storeCard: {
          headerFields: header,
          primaryFields: [{ key: 'b', label: 'Balance', value: '5' }],
        },
      },
      ctx,
    );
    expect(store.fields.map((f) => f.label)).toEqual(['Balance', 'Date']);
  });
});

describe('pass email', () => {
  it('shows the pass before the badge, one action and the open-on-iPhone line', () => {
    const { html, text } = render();
    const title = html.indexOf('Harbor Lights 2026');
    const badge = html.indexOf('alt="Add to Apple Wallet"');
    expect(title).toBeGreaterThan(-1);
    expect(title).toBeLessThan(badge);
    expect(html.indexOf('Pier 62')).toBeLessThan(badge);
    expect(html.indexOf('Row A, seat 4')).toBeLessThan(badge);
    expect(html.indexOf('Nov 16, 2026')).toBeLessThan(badge);
    // The event field repeats the title, so it is left out.
    expect(html).not.toContain('>Event<');
    expect(html).not.toContain('Manage pass');
    expect(text).not.toContain('Manage pass');
    expect(html).toContain('Open your pass');
    expect(html).toContain(ADD_LINE);
    expect(text).toContain(ADD_LINE);
    expect(text).toContain('Venue: Pier 62');
    expect(html.match(/class="e-btn"/g) ?? []).toHaveLength(0);
    expect(html.indexOf('Open your pass')).toBeGreaterThan(badge);
  });

  it('pairs the unmodified badge with a button of its box and corner', () => {
    const { html } = render();
    const { width, height } = EMAIL_BADGE;
    // The art alone: no white cell or padding around it.
    expect(html).toContain(
      `margin:0 12px 12px 0"><!--<![endif]--><a href="https://w.test/p/t/pass.pkpass" style="display:block;text-decoration:none"><img src="https://w.test/apple/badge/en/black@2x.png" alt="Add to Apple Wallet" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`,
    );
    // 42 px inside a 1 px outline: the badge's 44, at lg, the radius nearest its corner.
    expect(html).toContain(
      `<table role="presentation" width="${width}" cellspacing="0" cellpadding="0" style="width:${width}px;border-collapse:separate"><tr><td class="e-block" align="center" height="${height - 2}" style="height:${height - 2}px;padding:0;border:1px solid ${EMAIL_LIGHT.lineStrong};border-radius:${RADIUS.lg}px">`,
    );
    expect(html).toMatch(
      new RegExp(
        `<a class="e-block" href="https://w.test/p/t" style="display:block;color:${EMAIL_LIGHT.text};[^"]*font-size:14px;line-height:${height - 2}px;mso-line-height-rule:exactly;font-weight:500;[^"]*">Open your pass</a>`,
      ),
    );
  });

  it.each([
    { providers: [] as const },
    { providers: ['google'] as const },
    { providers: ['samsung'] as const },
    { providers: ['google', 'samsung'] as const },
  ])('renders every available wallet and no others: $providers', ({ providers }) => {
    const offers = providers.map((provider) => ({
      provider,
      href: `/p/t/wallet/${provider}`,
      installation: 'unknown' as const,
    }));
    const { html, text } = render({ publicBaseUrl: 'https://w.test', walletOffers: offers });
    expect(html).toContain('href="https://w.test/p/t/pass.pkpass"');
    expect(html).toContain('alt="Add to Apple Wallet"');
    expect(text).toContain('Add to Apple Wallet: https://w.test/p/t/pass.pkpass');
    expect(html).toContain('href="https://w.test/p/t"');
    expect(text).toContain('Open your pass: https://w.test/p/t');
    for (const [provider, label, asset] of [
      ['google', 'Add to Google Wallet', '/icons/wallet-providers/google/add-to-google-wallet.svg'],
      [
        'samsung',
        'Add to Samsung Wallet',
        '/icons/wallet-providers/samsung/add-to-samsung-wallet.png',
      ],
    ] as const) {
      if (providers.some((p) => p === provider)) {
        expect(html).toContain(`href="https://w.test/p/t/wallet/${provider}"`);
        expect(html).toContain(`src="https://w.test${asset}" alt="${label}"`);
        expect(text).toContain(`${label}: https://w.test/p/t/wallet/${provider}`);
      } else {
        expect(html).not.toContain(asset);
        expect(html).not.toContain(label);
        expect(text).not.toContain(label);
      }
    }
  });

  it('keeps text links for mail clients that cannot show the badges', () => {
    const { html } = render({
      publicBaseUrl: 'https://w.test',
      walletOffers: [
        { provider: 'google', href: '/p/t/wallet/google', installation: 'unknown' },
        { provider: 'samsung', href: '/p/t/wallet/samsung', installation: 'unknown' },
      ],
    });
    expect(html).toContain(
      'alt="Add to Google Wallet" width="283" height="50" style="display:block;width:283px;max-width:100%;height:auto;',
    );
    expect(html).toContain(
      'alt="Add to Samsung Wallet" width="242" height="50" style="display:block;width:242px;max-width:100%;height:auto;',
    );
    const withoutImages = html.replace(/<img [^>]*>/g, '');
    expect(withoutImages).toMatch(
      /href="https:\/\/w\.test\/p\/t\/wallet\/google"[^>]*>Add to Google Wallet<\/a>/,
    );
    expect(withoutImages).toMatch(
      /href="https:\/\/w\.test\/p\/t\/wallet\/samsung"[^>]*>Add to Samsung Wallet<\/a>/,
    );
  });

  it('does not make installation claims for available offers', () => {
    const { html, text } = render({
      publicBaseUrl: 'https://w.test',
      walletOffers: [
        { provider: 'google', href: '/p/t/wallet/google', installation: 'unknown' },
        { provider: 'samsung', href: '/p/t/wallet/samsung', installation: 'unknown' },
      ],
    });
    for (const provider of ['google', 'samsung']) {
      expect(html).toContain(`href="https://w.test/p/t/wallet/${provider}"`);
      expect(text).toContain(`https://w.test/p/t/wallet/${provider}`);
    }
    expect(html.toLowerCase()).not.toMatch(/\b(installed|removed)\b/);
    expect(text.toLowerCase()).not.toMatch(/\b(installed|removed)\b/);
  });

  it('escapes capability links in HTML and retains them as text', () => {
    const { html, text } = render({
      orgName: 'A&B <Gym>',
      manageUrl: 'https://w.test/p/t&x',
      publicBaseUrl: 'https://w.test',
      walletOffers: [
        { provider: 'google', href: '/p/t&x/wallet/google', installation: 'unknown' },
        { provider: 'samsung', href: '/p/t&x/wallet/samsung', installation: 'unknown' },
      ],
    });
    expect(html).toContain('A&amp;B &lt;Gym&gt;');
    for (const provider of ['google', 'samsung']) {
      expect(html).toContain(`href="https://w.test/p/t&amp;x/wallet/${provider}"`);
      expect(text).toContain(`https://w.test/p/t&x/wallet/${provider}`);
    }
    expect(html).not.toContain('A&B <Gym>');
  });

  it('omits links that are not capabilities for this pass and never exposes their tokens', () => {
    const { html, text } = render({
      publicBaseUrl: 'https://w.test',
      walletOffers: [
        {
          provider: 'google',
          href: 'https://pay.google.test/save/private-google-jwt',
          installation: 'unknown',
        },
        {
          provider: 'samsung',
          href: '/p/t/wallet/samsung?token=private-samsung-token',
          installation: 'unknown',
        },
        { provider: 'google', href: '/p/other-pass/wallet/google', installation: 'unknown' },
        {
          provider: 'samsung',
          href: '/p/t/wallet/samsung" onmouseover="bad',
          installation: 'unknown',
        },
      ],
    });
    for (const value of [
      'private-google-jwt',
      'private-samsung-token',
      'other-pass',
      'onmouseover',
      'Add to Google Wallet',
      'Add to Samsung Wallet',
    ]) {
      expect(html).not.toContain(value);
      expect(text).not.toContain(value);
    }
    expect(html).toContain('alt="Add to Apple Wallet"');
  });

  it('needs an absolute public base before rendering native offers', () => {
    const walletOffers = [
      { provider: 'google' as const, href: '/p/t/wallet/google', installation: 'unknown' as const },
    ];
    for (const publicBaseUrl of [undefined, '/relative', 'javascript:alert(1)']) {
      const email = render({ publicBaseUrl, walletOffers });
      expect(email.html).not.toContain('Add to Google Wallet');
      expect(email.text).not.toContain('Add to Google Wallet');
    }
  });

  it('wraps the pair without media queries, side by side or stacked, and in a row in Outlook', () => {
    const { html } = render();
    const { width } = EMAIL_BADGE;
    const items = html.match(/<div style="display:inline-block;vertical-align:top;[^"]*">/g) ?? [];
    expect(items).toEqual([
      `<div style="display:inline-block;vertical-align:top;width:${width}px;margin:0 12px 12px 0">`,
      `<div style="display:inline-block;vertical-align:top;width:${width}px;margin:0 0 12px 0">`,
    ]);
    // Word has no inline blocks and drops div margins: the blocks are hidden from it, and it gets
    // two badge-wide cells with a 12 px one between.
    expect(html.match(/<!--\[if !mso\]><!--><div style="display:inline-block/g)).toHaveLength(2);
    expect(html).toContain(
      `<!--[if mso]></td><td width="12" style="width:12px;font-size:0;line-height:0">&nbsp;</td><td width="${width}" valign="top" style="width:${width}px;padding:0 0 12px"><![endif]-->`,
    );
    expect(html).not.toMatch(/@media[^{]*(max|min)-width/);
  });

  it('degrades to fixed tables in Word-rendered Outlook', () => {
    const { html } = render({ buddyBase: 'https://w.test', iconUrl: ICON });
    const opened = html.match(/<!--\[if (!?)mso\]>/g) ?? [];
    expect(opened.length).toBeGreaterThan(0);
    expect(html.match(/<!\[endif\]-->/g)).toHaveLength(opened.length);
    // What Word sees: mso blocks shown, !mso blocks hidden.
    const word = html
      .replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/g, '')
      .replace(/<!--\[if mso\]>([\s\S]*?)<!\[endif\]-->/g, '$1');
    expect(word).not.toMatch(/inline-block|display:\s*(flex|grid)/);
    // max-width alone would let the column fill the window: a 480 px table holds it.
    expect(word).toMatch(
      /<table role="presentation" width="480" align="center"[^>]*><tr><td>\s*<table[^>]*max-width:480px/,
    );
    // The foil is a gradient Word cannot draw: a solid 2 px row of its first colour instead.
    expect(word).toContain(
      `<tr><td height="2" bgcolor="${EMAIL_LIGHT.foil1}" style="height:2px;background:${EMAIL_LIGHT.foil1};`,
    );
    // Every image keeps its box when blocked or scaled.
    for (const img of word.match(/<img [^>]*>/g) ?? [])
      expect(img).toMatch(/ width="\d+" height="\d+"/);
    expect(html).toContain('<o:PixelsPerInch>96</o:PixelsPerInch>');
  });

  it('is static and keeps the card radius on every corner', () => {
    const { html } = render();
    expect(html).not.toMatch(/@keyframes|\.gif/i);
    expect(html).toContain('border-radius:18px 18px 0 0');
    expect(html).toContain('border-radius:0 0 18px 18px');
  });

  it('sends from "<Org> via <sender>"', () => {
    expect(render().fromName).toBe('Harbor Lights Festival via PassBook');
    expect(render({ senderName: '' }).fromName).toBeUndefined();
  });

  it("leaves the buddy out by default: the org's pass, under the org's name on the page", () => {
    const { html } = render();
    expect(html).not.toContain('/email/buddy-');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).toMatch(
      /padding:14px 0 14px 25px;font-size:20px;line-height:28px;mso-line-height-rule:exactly;font-weight:600;[^"]*">Harbor Lights/,
    );
    expect(render({ buddyBase: null })).toEqual(render());
  });

  describe('with the buddy (org opted in)', () => {
    const BASE = 'https://w.test';
    const withBuddy = () => render({ buddyBase: BASE });

    it('seats the happy buddy at M: top in the band, legs over the foil', () => {
      expect(PASS_EMAIL_MOOD).toBe('happy');
      const { html } = withBuddy();
      const top = html.indexOf(`src="${BASE}/email/buddy-m-happy-light-top-2x.png"`);
      const legs = html.indexOf(`src="${BASE}/email/buddy-m-happy-light-legs-2x.png"`);
      const { width, seam } = EMAIL_BUDDY.m;
      expect(html).toContain(`width="${width}" height="${seam}"`);
      // The org's name leads the band; the buddy sits at its right end.
      expect(html.indexOf('Harbor Lights Festival</td>')).toBeLessThan(top);
      expect(top).toBeLessThan(html.indexOf('class="e-card"'));
      expect(html.indexOf('class="e-seam"')).toBeLessThan(legs);
      expect(legs).toBeLessThan(html.indexOf('Your pass is ready</p>'));
      expect(html).toContain(
        `<source srcset="${BASE}/email/buddy-m-happy-dark-top-2x.png 2x, ${BASE}/email/buddy-m-happy-dark-top-3x.png 3x" media="(prefers-color-scheme: dark)">`,
      );
      expect(html).not.toContain('buddy-curious');
      // Org-first: no PassBook mark beside the org's name.
      expect(html).not.toContain('apple-touch-icon');
    });

    it("is the sign-in email's band at M, from the same shell", () => {
      const band = (html: string) => /<tr><td><table[\s\S]*?class="e-card"/.exec(html)?.[0] ?? '';
      const signIn = renderSignInEmail({
        purpose: 'sign_in',
        link: `${BASE}/auth/magic?t=abc`,
        base: BASE,
        code: '123456',
        expiresMinutes: 15,
      });
      const strip = (html: string) =>
        band(html)
          .replace(/<img src="[^"]*" alt="" width="24"/, '<img src="" alt="" width="24"')
          .replace(/>(PassBook|Harbor Lights Festival)</, '><')
          // The tier sets the sizes; the composition is the same.
          .replace(/buddy-m-/g, 'buddy-')
          .replace(/\d+/g, '#');
      const pass = render({ buddyBase: BASE, iconUrl: ICON }).html;
      expect(band(pass)).toContain(`<img src="${ICON}" alt="" width="24"`);
      expect(strip(pass)).toBe(strip(signIn.html));
    });

    it('keeps the plain-text part, subject and sender unchanged', () => {
      const plain = render();
      const buddy = withBuddy();
      expect(buddy.text).toBe(plain.text);
      expect(buddy.subject).toBe(plain.subject);
      expect(buddy.fromName).toBe(plain.fromName);
    });

    it('needs an absolute base URL, as the sign-in email does', () => {
      expect(render({ buddyBase: '/relative' }).html).toBe(render().html);
      expect(render({ buddyBase: 'javascript:alert(1)' }).html).toBe(render().html);
    });
  });

  it('keeps the plain-text part word for word', () => {
    expect(render().text).toBe(
      'Your pass is ready\n\nHarbor Lights 2026\nVenue: Pier 62\nDate: Nov 16, 2026\nSeat: Row A, seat 4\n\nAdd to Apple Wallet: https://w.test/p/t/pass.pkpass\nOpen your pass: https://w.test/p/t\nOpen on iPhone or Mac to add to Apple Wallet.\n\nKeep this email private. Its links open your pass.',
    );
  });

  it('still renders without a pass summary', () => {
    const { html } = render({ summary: null, passTitle: null });
    expect(html).toContain('alt="Add to Apple Wallet"');
  });

  it('frames the pass in its own colour, or in the card hairline where it would melt in', () => {
    expect(render().html).toContain(
      'class="e-line" style="background:rgb(40, 30, 120);border:1px solid rgb(40, 30, 120);',
    );
    const white = passSummary(
      { ...PASS_JSON, backgroundColor: 'rgb(255, 255, 255)' },
      { now: new Date() },
    );
    expect(render({ summary: white }).html).toContain(
      `class="e-line" style="background:rgb(255, 255, 255);border:1px solid ${EMAIL_LIGHT.line};`,
    );
  });
});

describe("the org's mark and the pass logo", () => {
  const LOGO = 'https://w.test/p/t/assets/logo@3x.png?v=1';
  const logoTag = (html: string) => /<img src="[^"]*logo@3x[^>]*>/.exec(html)?.[0];

  it('puts the pass icon before the org name in the band, decorative and fixed', () => {
    const { html } = render({ iconUrl: ICON });
    const mark = html.indexOf(
      `<img src="${ICON}" alt="" width="24" height="24" style="display:block;width:24px;height:24px;`,
    );
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(html.indexOf('>Harbor Lights Festival</td>'));
    expect(html.indexOf('>Harbor Lights Festival</td>')).toBeLessThan(
      html.indexOf('class="e-card"'),
    );
    for (const iconUrl of ['/p/t/assets/icon.png', 'javascript:alert(1)', null])
      expect(render({ iconUrl }).html).toBe(render().html);
  });

  it('draws the logo on the pass block at its aspect, at most 36 tall, named by alt', () => {
    const { html } = render({ logo: { url: LOGO, width: 108, height: 50 } });
    expect(logoTag(html)).toBe(
      `<img src="${LOGO}" alt="Harbor Lights Festival" width="78" height="36" style="display:block;width:78px;height:36px;border:0">`,
    );
    expect(html.indexOf('class="e-line"')).toBeLessThan(html.indexOf(LOGO));
    expect(html.indexOf(LOGO)).toBeLessThan(html.indexOf('>Harbor Lights 2026</p>'));
    const wide = render({ logo: { url: LOGO, width: 300, height: 50 } }).html;
    expect(logoTag(wide)).toContain('width="160" height="27"');
    const small = render({ logo: { url: LOGO, width: 40, height: 20 } }).html;
    expect(logoTag(small)).toContain('width="40" height="20"');
  });

  it("sets the pass's logoText beside the logo, so the image's alt is empty", () => {
    const { html } = render({
      logo: { url: LOGO, width: 50, height: 50 },
      logoText: 'Harbor Lights',
    });
    expect(logoTag(html)).toContain('alt="" width="36" height="36"');
    expect(html).toMatch(/font-weight:600;color:rgb\(255, 255, 255\)">Harbor Lights<\/td>/);
  });

  it('leaves the logo out without a size or an absolute URL', () => {
    for (const logo of [
      { url: LOGO, width: 0, height: 50 },
      { url: '/p/t/assets/logo.png', width: 100, height: 50 },
      null,
    ])
      expect(render({ logo, logoText: 'Harbor Lights' }).html).toBe(render().html);
  });
});

describe('sign-in email', () => {
  it('shows the code as a chip, the mark and a 44 px button', () => {
    const { html, text } = renderSignInEmail({
      purpose: 'sign_in',
      link: 'https://w.test/auth/magic?t=abc',
      base: 'https://w.test',
      code: '123456',
      expiresMinutes: 15,
    });
    const chip = /<span class="e-chip[^"]*" style="([^"]*)">123456<\/span>/.exec(html)?.[1] ?? '';
    expect(chip).toContain('letter-spacing:6px');
    expect(chip).not.toContain('border:');
    expect(html).toContain('src="https://w.test/apple-touch-icon.png"');
    expect(html).toMatch(/class="e-btn"[^>]*padding:11px 24px/);
    expect(html).not.toMatch(/@keyframes|\.gif/i);
    expect(text.split('\n\n')[0]).toBe('Sign in to PassBook');
  });
});
