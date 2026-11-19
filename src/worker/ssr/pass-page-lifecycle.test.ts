import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { assets } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { renderPassPage } from './pass-page.tsx';

const NOW = new Date('2026-11-19T12:00:00Z');

const passJson = (message = '', extra: Record<string, unknown> = {}): PassJson =>
  ({
    formatVersion: 1,
    organizationName: 'Northwind',
    description: 'Membership',
    serialNumber: 's',
    passTypeIdentifier: 'pass.x',
    teamIdentifier: 'T',
    generic: {
      headerFields: [
        { key: 'tier', label: 'Tier', value: 'Pro' },
        { key: 'status', label: 'Status', value: 'Active' },
      ],
      primaryFields: [{ key: 'holder', label: 'Name', value: 'Maya Chen' }],
      backFields: [
        { key: 'message', label: 'Message', value: message },
        { key: 'note', label: 'Note', value: 'Upgraded to Pro.' },
        { key: 'terms', label: 'Terms', value: 'Present the barcode.' },
      ],
    },
    ...extra,
  }) as unknown as PassJson;

function page(json: PassJson, over: Record<string, unknown> = {}): string {
  const view = normalize(json, {
    assets,
    now: NOW,
    ...(over.voided ? { stateWord: 'Voided' } : {}),
  });
  return renderPassPage({
    view,
    passJson: json,
    now: NOW,
    nonce: 'n',
    orgName: 'Northwind',
    orgLabel: 'Northwind',
    passTitle: 'Maya Chen',
    downloadHref: '/p/t/pass.pkpass',
    walletOffers: [],
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'iphone', inApp: false },
    ...over,
  });
}
const details = (html: string) => html.slice(html.indexOf('>Details</h2>'));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('/p tells the holder what the org wrote', () => {
  it('shows the latest message and the note in Details, not the terms', () => {
    const body = text(details(page(passJson('Pool closed Monday for cleaning.'))));
    expect(body).toContain('Message Pool closed Monday for cleaning.');
    expect(body).toContain('Note Upgraded to Pro.');
    expect(body).not.toContain('Present the barcode.');
  });

  it('shows no empty message', () => {
    expect(text(details(page(passJson('')))).includes('Message')).toBe(false);
  });
});

describe('/p never says Active beside a void', () => {
  it('states Voided in Details and on the card, with the void date and next step', () => {
    const html = page(passJson(), {
      voided: true,
      endedOn: 'Nov 18, 2026',
      support: { email: 'desk@northwind.test', url: null },
    });
    expect(text(details(html))).toContain('Status Voided');
    expect(text(html)).not.toMatch(/Status\s+Active/i);
    expect(text(html)).toContain('This pass was voided on Nov 18, 2026. It no longer works.');
    expect(text(html)).toContain('Contact Northwind');
  });

  it('keeps Active for a live pass', () => {
    expect(text(details(page(passJson())))).toContain('Status Active');
  });
});
