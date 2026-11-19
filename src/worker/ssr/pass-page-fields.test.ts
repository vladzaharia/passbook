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

function detailsOf(passJson: PassJson): string {
  const view = normalize(passJson, {
    assets,
    now: new Date('2026-10-31T12:00:00Z'),
    timeZone: 'UTC',
  });
  const html = renderPassPage({
    view,
    passJson,
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
  const at = html.indexOf('>Details</h2>');
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

  it('shows Status once: the badge, not a pass field of the same label', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { auxiliaryFields: unknown[] };
    block.auxiliaryFields.push({ key: 'status', label: 'Status', value: 'On time' });
    const text = detailsOf(passJson);
    expect(text.match(/Status/g)).toHaveLength(1);
    expect(text).not.toContain('On time');
  });

  it('does not repeat expiry when the pass lists its own Expires field', () => {
    const passJson = starter('starter-boarding-pass');
    const block = passJson.boardingPass as { auxiliaryFields: unknown[] };
    block.auxiliaryFields.push({ key: 'expires', label: 'Expires', value: 'Never' });
    expect(detailsOf(passJson).match(/Expires/g)).toHaveLength(1);
  });

  it('a pass without an expiry has no Expires row', () => {
    const { expirationDate: _drop, ...rest } = starter('starter-boarding-pass');
    expect(detailsOf(rest)).not.toContain('Expires');
  });
});
