import { describe, expect, it } from 'vitest';
import boarding from '../../../templates/starter-boarding-pass/pass.json?raw';
import event from '../../../templates/starter-event-ticket/pass.json?raw';
import timed from '../../../templates/starter-timed-ticket/pass.json?raw';
import type { PassJson } from '../../passkit/types.ts';
import { assets } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { renderPassPage } from './pass-page.tsx';

const GROUPS = ['backFields'] as const;
const STYLES = ['boardingPass', 'eventTicket', 'storeCard', 'coupon', 'generic'];

const RAW: Record<string, string> = {
  'starter-boarding-pass': boarding,
  'starter-event-ticket': event,
  'starter-timed-ticket': timed,
};
const starter = (name: string): Record<string, unknown> & PassJson =>
  JSON.parse(RAW[name] as string) as PassJson;

function detailsOf(passJson: PassJson, timeZone?: string): string {
  const view = normalize(passJson, {
    assets,
    now: new Date('2026-10-31T12:00:00Z'),
    timeZone: 'UTC',
  });
  const html = renderPassPage({
    view,
    passJson,
    ...(timeZone ? { timeZone } : {}),
    now: new Date('2026-10-31T12:00:00Z'),
    nonce: 'n',
    orgName: 'Org',
    orgLabel: 'Org',
    passTitle: 'Pass',
    downloadHref: '/p/t/pass.pkpass',
    walletOffers: [],
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'iphone', inApp: false },
  });
  const at = html.indexOf('class="wl-holder-details"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at).replace(/<[^>]+>/g, ' ');
}

const fieldsOf = (passJson: Record<string, unknown>, group: (typeof GROUPS)[number]) => {
  const style = STYLES.find((s) => passJson[s]) as string;
  const list = (passJson[style] as Record<string, unknown>)[group];
  return (Array.isArray(list) ? list : []) as { label?: string; value?: unknown }[];
};

describe("/p's details are the back of the pass, never its face", () => {
  for (const name of ['starter-boarding-pass', 'starter-event-ticket', 'starter-timed-ticket']) {
    const passJson = starter(name);
    const back = fieldsOf(passJson, 'backFields').filter(
      (f) => typeof f.value === 'string' && f.value.trim() && !/status/i.test(String(f.label)),
    );
    if (back.length) {
      it(`${name}: every back field`, () => {
        const text = detailsOf(passJson).toLowerCase();
        for (const f of back) expect(text).toContain(String(f.label).toLowerCase());
      });
    }
    it(`${name}: expiry`, () => {
      expect(detailsOf(passJson)).toMatch(/Expires\s+\w{3} \d{1,2}, \d{4}/);
    });
  }

  it('boarding pass: the passenger is on the card, not repeated under it', () => {
    const text = detailsOf(starter('starter-boarding-pass'));
    expect(text).not.toContain('Passenger');
  });

  it('shows no state of its own, but every back field, a status one included', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { backFields?: unknown[] };
    block.backFields = [
      ...(block.backFields ?? []),
      { key: 'status', label: 'Status', value: 'On time' },
    ];
    const text = detailsOf(passJson);
    // The back says it, as the card's back does; the page adds no pill.
    expect(text).toContain('Status');
    expect(text).toContain('On time');
    expect(text).not.toContain('Active');
  });

  it('does not repeat expiry when the card lists its own Expires field', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { auxiliaryFields: unknown[] };
    block.auxiliaryFields.push({ key: 'expires', label: 'Expires', value: 'Never' });
    expect(detailsOf(passJson)).not.toContain('Expires');
  });

  it('names the zone of Expires when the visitor zone is unknown, in the pass own offset', () => {
    const passJson = {
      ...starter('starter-boarding-pass'),
      expirationDate: '2030-06-01T16:30:00-04:00',
    };
    expect(detailsOf(passJson)).toMatch(/Expires\s+Jun 1, 2030, 4:30 PM GMT-4/);
    const utc = { ...passJson, expirationDate: '2030-06-01T16:30:00Z' };
    // A `Z` is how the time was written, not a zone: it reads in Seattle time.
    expect(detailsOf(utc)).toMatch(/Expires\s+Jun 1, 2030, 9:30 AM PDT/);
  });

  it('shows Expires in the visitor zone without a zone name when it is known', () => {
    const passJson = {
      ...starter('starter-boarding-pass'),
      expirationDate: '2030-06-01T16:30:00-04:00',
    };
    expect(detailsOf(passJson, 'America/Los_Angeles')).toMatch(
      /Expires\s+Jun 1, 2030, 1:30 PM(?! GMT| UTC)/,
    );
  });

  it('a pass without an expiry has no Expires row', () => {
    const { expirationDate: _drop, ...rest } = starter('starter-boarding-pass');
    expect(detailsOf(rest)).not.toContain('Expires');
  });
});
