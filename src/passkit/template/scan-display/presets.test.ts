import { describe, expect, it } from 'vitest';
import type { PassJson, ScanRowDoc, TemplateManifest } from '../../types.ts';
import { bakedSlugs, loadBaked } from '../baked-fixtures.ts';
import { EXAMPLES, exampleManifest, type ScanExample } from './examples.ts';
import { PRESET_ORDER, PRESETS, slotsFound } from './presets.ts';
import { renderDoc, scopeOf } from './test-kit.ts';
import { scanDisplayIssues } from './validate.ts';

const example = (id: ScanExample['id']) => EXAMPLES.find((e) => e.id === id) as ScanExample;
const withInputs = (manifest: TemplateManifest, add: Record<string, object>): TemplateManifest => ({
  ...manifest,
  inputs: {
    ...manifest.inputs,
    properties: { ...manifest.inputs.properties, ...add } as never,
  },
});

describe('presets', () => {
  it.each(bakedSlugs())('every preset validates against %s', async (slug) => {
    const { template } = await loadBaked(slug);
    for (const id of PRESET_ORDER) {
      const panel = PRESETS[id].build(template.manifest, {}, { passJson: template.passJson });
      const manifest: TemplateManifest = {
        ...template.manifest,
        scan: {
          actions: template.manifest.scan?.actions ?? [
            { id: 'check_in', label: 'Check in', kind: 'check_in' },
          ],
          display: { v: 1, holder: '{{pass.title}}', header: {}, panels: [panel] },
        },
      };
      const issues = scanDisplayIssues(manifest, { passJson: template.passJson as PassJson });
      expect(
        issues.filter((i) => i.severity === 'error'),
        `${slug} ${id}`,
      ).toEqual([]);
      expect(panel.preset).toEqual({ id, v: PRESETS[id].v });
      expect(panel.rows.length).toBeGreaterThan(0);
    }
  });

  it('tags every row with a slot and writes no photo row', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    for (const id of PRESET_ORDER)
      for (const row of PRESETS[id].build(template.manifest).rows) {
        expect(row.slot, `${id} ${row.id}`).toBeTruthy();
        expect(row.type).not.toBe('image');
      }
  });

  it('Ticket writes a 4-item big columns row when a gate input exists', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const manifest = exampleManifest(template.manifest, example('vip'));
    const rows = PRESETS.ticket.build(manifest).rows;
    expect(rows[0]).toMatchObject({ type: 'columns', size: 'big' });
    const items = (rows[0] as { items: { label: string }[] }).items;
    expect(items.map((i) => i.label)).toEqual(['Section', 'Row', 'Seat', 'Gate']);
    expect(slotsFound(manifest, PRESETS.ticket)).toBeGreaterThanOrEqual(5);
  });

  it('Ticket writes a big row for the event blueprint single seat, within 5 units', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const rows = PRESETS.ticket.build(template.manifest).rows;
    expect(rows.map((r) => r.type)).toEqual(['big', 'field', 'field', 'field']);
    expect(rows.map((r) => (r as { value?: string }).value)).toEqual([
      '{{inputs.seat}}',
      '{{inputs.admission}}',
      '{{inputs.doorsAt|time}}',
      '{{inputs.venueRoom}}',
    ]);
    const shipped = example('event').display.panels?.[0]?.rows as ScanRowDoc[];
    expect(JSON.stringify(rows)).toBe(JSON.stringify(shipped));
  });

  it('Balance and Loyalty follow the actions', async () => {
    const { template: store } = await loadBaked('starter-store-card');
    const balance = PRESETS.balance.build(exampleManifest(store.manifest, example('prepaid')));
    expect(balance.rows).toMatchObject([
      {
        type: 'money',
        amount: '{{inputs.balance}}',
        currency: '{{inputs.currency}}',
        pending: ['charge', 'top_up'],
      },
      { type: 'history', source: 'value', input: 'balance', limit: 3 },
    ]);
    const loyalty = PRESETS.loyalty.build(exampleManifest(store.manifest, example('coffee')));
    expect(loyalty.rows[0]).toMatchObject({
      type: 'progress',
      value: '{{inputs.stamps}}',
      reward: 'Free coffee',
    });
    expect(loyalty.rows[0]).not.toHaveProperty('goal');
  });

  it('Loyalty without a take action writes its own goal', async () => {
    const { template } = await loadBaked('starter-store-card');
    const manifest = withInputs(template.manifest, { stamps: { type: 'integer' } });
    expect(PRESETS.loyalty.build(manifest).rows[0]).toMatchObject({ goal: 10 });
  });

  it('Membership reads the tier input', async () => {
    const { template } = await loadBaked('starter-generic');
    expect(PRESETS.membership.build(template.manifest).rows[0]).toMatchObject({ type: 'chips' });
  });

  it('Offer maps the coupon blueprint', async () => {
    const { template } = await loadBaked('starter-coupon');
    expect(PRESETS.offer.build(template.manifest).rows).toMatchObject([
      { type: 'big', value: '{{inputs.offer}}' },
      { type: 'field', label: 'Conditions', value: '{{inputs.validFor}}' },
      { type: 'field', label: 'Use by' },
    ]);
  });

  it('Details quick-picks the front fields and Access reads boolean inputs', async () => {
    const { template } = await loadBaked('starter-store-card');
    const rows = PRESETS.details.build(template.manifest, {}, { passJson: template.passJson }).rows;
    expect(rows[0]).toMatchObject({ type: 'field', label: 'Balance', value: '{{fields.balance}}' });
    const manifest = withInputs(template.manifest, {
      lounge: { type: 'boolean' },
      parking: { type: 'boolean', 'x-label': 'Free parking' },
    });
    const access = PRESETS.access.build(manifest).rows[0] as {
      items: { icon: string; text: string; when: object }[];
    };
    expect(access.items.map((i) => [i.icon, i.text])).toEqual([
      ['armchair', 'Lounge'],
      ['parking', 'Free parking'],
    ]);
    expect(access.items[0]?.when).toEqual({ path: 'inputs.lounge', eq: true });
  });

  it('renders a preset panel, and Note renders nothing until written', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const panel = PRESETS.ticket.build(template.manifest);
    const doc = { v: 1 as const, holder: '{{inputs.attendee}}', header: {}, panels: [panel] };
    const out = renderDoc(
      doc,
      scopeOf({ seat: 'Row F, Seat 12', admission: 'GA', venueRoom: 'Main' }),
    );
    expect(out.panels[0]?.rows.map((r) => r.type)).toEqual(['big', 'field', 'field']);
    expect(
      renderDoc({ v: 1, header: {}, panels: [PRESETS.note.build(template.manifest)] }).panels,
    ).toEqual([]);
  });
});
