import { describe, expect, it } from 'vitest';
import boarding from '../../../templates/starter-boarding-pass/pass.json?raw';
import event from '../../../templates/starter-event-ticket/pass.json?raw';
import timed from '../../../templates/starter-timed-ticket/pass.json?raw';
import type { PassJson } from '../../passkit/types.ts';
import { assets } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { renderPassPage } from './pass-page.tsx';

const GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields'] as const;
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

describe('/p lists every front field of the pass', () => {
  for (const name of ['starter-boarding-pass', 'starter-event-ticket', 'starter-timed-ticket']) {
    const passJson = starter(name);
    for (const group of GROUPS) {
      const fields = fieldsOf(passJson, group).filter((f) => typeof f.value === 'string');
      if (!fields.length) continue;
      it(`${name}: ${group}`, () => {
        const text = detailsOf(passJson).toLowerCase();
        for (const f of fields) expect(text).toContain(String(f.label).toLowerCase());
      });
    }
    it(`${name}: expiry`, () => {
      expect(detailsOf(passJson)).toMatch(/Expires\s+\w{3} \d{1,2}, \d{4}/);
    });
  }

  it('boarding pass: passenger and boarding time, not only the card face', () => {
    const text = detailsOf(starter('starter-boarding-pass'));
    expect(text).toContain('Passenger');
    expect(text).toContain('Alex Morgan');
    expect(text).toContain('Boards');
  });

  it('shows the state once, as the pill: no Status label, no pass field of that label', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { auxiliaryFields: unknown[] };
    block.auxiliaryFields.push({ key: 'status', label: 'Status', value: 'On time' });
    const text = detailsOf(passJson);
    expect(text).not.toMatch(/Status/);
    expect(text).toContain('Active');
    expect(text).not.toContain('On time');
  });

  it('does not repeat expiry when the pass lists its own Expires field', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { auxiliaryFields: unknown[] };
    block.auxiliaryFields.push({ key: 'expires', label: 'Expires', value: 'Never' });
    expect(detailsOf(passJson).match(/Expires/g)).toHaveLength(1);
  });

  it('names the zone of Expires when the visitor zone is unknown, in the pass own offset', () => {
    const passJson = {
      ...starter('starter-boarding-pass'),
      expirationDate: '2030-06-01T16:30:00-04:00',
    };
    expect(detailsOf(passJson)).toMatch(/Expires\s+Jun 1, 2030, 4:30 PM GMT-4/);
    const utc = { ...passJson, expirationDate: '2030-06-01T16:30:00Z' };
    expect(detailsOf(utc)).toMatch(/Expires\s+Jun 1, 2030, 4:30 PM UTC/);
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
