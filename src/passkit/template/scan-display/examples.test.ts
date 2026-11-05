import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { ScanRole, TemplateManifest } from '../../types.ts';
import { loadBaked } from '../baked-fixtures.ts';
import { EXAMPLES, exampleManifest, type ScanExample } from './examples.ts';
import { renderScanDisplay } from './render.ts';
import { sampleScope } from './sample.ts';
import { NOW } from './test-kit.ts';
import { scanDisplayIssues } from './validate.ts';

const get = (id: ScanExample['id']) => EXAMPLES.find((e) => e.id === id) as ScanExample;

/** The blueprint when it is on this branch, else the stand-in the example names. */
async function manifestFor(example: ScanExample): Promise<TemplateManifest> {
  for (const slug of [example.base, example.standIn]) {
    if (!slug) continue;
    try {
      return exampleManifest((await loadBaked(slug)).template.manifest, example);
    } catch {
      // Not on this branch yet.
    }
  }
  throw new Error(`no base for ${example.id}`);
}

function render(
  example: ScanExample,
  manifest: TemplateManifest,
  screen: 'ok' | 'ready' | 'heads_up' | 'refused',
  role: ScanRole = 'desk',
  extra: Record<string, never> = {},
) {
  const scope = sampleScope(manifest, { now: NOW, ...(example.scope ?? {}), ...extra });
  return renderScanDisplay(example.display, scope, {
    screen,
    role,
    locale: 'en',
    timeZone: 'America/New_York',
    now: NOW,
  });
}

describe.each(EXAMPLES)('example $id', (example) => {
  it('validates with no errors, so it fits on ok', async () => {
    const issues = scanDisplayIssues(await manifestFor(example));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it.each(['ready', 'ok', 'heads_up', 'refused'] as const)(
    'renders a valid %s screen',
    async (screen) => {
      const out = render(example, await manifestFor(example), screen);
      expect(() => ScanDisplaySchema.parse(out)).not.toThrow();
      expect(JSON.stringify(out)).not.toContain('{{');
    },
  );
});

describe('the owner examples render as DM section 8 says', () => {
  it('VIP: crown, gold chip, a 4-column Ticket on one line, an Access pair', async () => {
    const vip = get('vip');
    const manifest = await manifestFor(vip);
    const out = render(vip, manifest, 'ok');
    expect(out.header).toMatchObject({ icon: 'crown', meta: 'General admission' });
    expect(out.header.chips.map((c) => [c.text, c.tone])).toEqual([
      ['VIP', 'gold'],
      ['Table 12', 'violet'],
    ]);
    expect(out.panels[0]?.rows[0]).toMatchObject({ type: 'columns', oneLine: true });
    expect(out.panels[1]?.rows[0]).toMatchObject({ type: 'list', oneLine: true });
    expect(render(vip, manifest, 'heads_up').panels.map((p) => p.id)).toEqual(['p_ticket']);
  });

  it('Gym: the photo is an identity setting and Welcome back leads the band', async () => {
    const gym = get('gym');
    const manifest = await manifestFor(gym);
    expect(render(gym, manifest, 'ok').header).toMatchObject({ title: 'Welcome back' });
    expect(render(gym, manifest, 'ok').identity.photo).not.toBeNull();
    expect(render(gym, manifest, 'ok', 'door').identity.photo).toBeNull();
  });

  it('Coffee: 9 of 10 stamps from 7, "1 more for Free coffee"', async () => {
    const coffee = get('coffee');
    const manifest = await manifestFor(coffee);
    const scope = sampleScope(manifest, {
      now: NOW,
      scan: { input: 'stamps', before: 7, after: 9, amount: 2 },
    });
    const out = renderScanDisplay(coffee.display, scope, {
      screen: 'ok',
      role: 'desk',
      locale: 'en',
      timeZone: 'UTC',
      now: NOW,
    });
    expect(out.panels[0]?.rows[0]).toMatchObject({
      type: 'progress',
      value: 9,
      goal: 10,
      before: 7,
      caption: '1 more for Free coffee',
    });
  });

  it('Prepaid: the money row and a ledger that ends in Changed elsewhere', async () => {
    const prepaid = get('prepaid');
    const out = render(prepaid, await manifestFor(prepaid), 'ok');
    const [money, history] = out.panels[0]?.rows ?? [];
    expect(money).toMatchObject({ type: 'money', text: '$42.50', currency: 'USD', low: false });
    const labels = (history as { items: { label: string | null }[] }).items.map((i) => i.label);
    expect(labels).toEqual(['Changed elsewhere', 'Charge', 'Charge', 'Top up']);
  });

  it('Coupon: the offer, On / When and Uses left / Use by', async () => {
    const coupon = get('coupon');
    const out = render(coupon, await manifestFor(coupon), 'ok');
    expect(out.panels[0]?.rows.map((r) => r.type)).toEqual(['big', 'columns', 'columns']);
    expect(out.header.meta).toBe('20% off');
  });

  it('Voided: the refused note and nothing else', async () => {
    const voided = get('voided');
    const out = render(voided, await manifestFor(voided), 'refused');
    expect(out.panels).toEqual([]);
    expect(out.notes.refused).toBe('Send them to the box office, left of the doors.');
  });
});
