import { describe, expect, it } from 'vitest';
import { ADD_LINE, renderPassEmail } from './pass.ts';
import { passSummary } from './pass-summary.ts';
import { EMAIL_LIGHT } from './shell.ts';
import { renderSignInEmail } from './sign-in.ts';

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
    // The kit Button at 44 px: 11 + 20 + 11 and the 1 px border.
    expect(html).toMatch(/class="e-block"[^>]*line-height:20px;font-weight:500;padding:11px 24px;/);
  });

  it('is static and keeps the card radius on every corner', () => {
    const { html } = render();
    expect(html).not.toMatch(/@keyframes|\.gif/i);
    expect(html).toContain('border-radius:18px 18px 0 0');
    expect(html).toContain('border-radius:0 0 18px 18px');
  });

  it('keeps the outline action in neutral text, like the hosted card', () => {
    const { html } = render();
    expect(html).toMatch(
      new RegExp(
        `class="e-block"[^>]*color:${EMAIL_LIGHT.text};border:1px solid ${EMAIL_LIGHT.lineStrong}`,
      ),
    );
  });

  it('sends from "<Org> via <sender>"', () => {
    expect(render().fromName).toBe('Harbor Lights Festival via PassBook');
    expect(render({ senderName: '' }).fromName).toBeUndefined();
  });

  it("leaves the buddy out: the org's pass, under the org's name on the page", () => {
    const { html } = render();
    expect(html).not.toContain('/email/buddy-');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).toMatch(
      /padding:14px 0 14px 25px;font-size:20px;line-height:28px;font-weight:600;[^"]*">Harbor Lights/,
    );
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
