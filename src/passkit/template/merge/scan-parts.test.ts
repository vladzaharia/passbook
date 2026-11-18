import { describe, expect, it } from 'vitest';
import { ids, kinds, man, run } from './merge-test-fixtures.ts';

const scan = (d: any) => d.manifest.scan;
const disp = (d: any) => d.manifest.scan.display;

describe('scan.actions and scan.meta', () => {
  it('actions merge by id with per-property K3, amount is atomic', () => {
    const r = run(
      (d) => (scan(d).actions[0].label = 'Plus'),
      (d) => {
        scan(d).actions[0].amount = { max: 5 };
        scan(d).actions.push({ id: 'void', label: 'Void', kind: 'take', input: 'pts', amount: 1 });
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r).scan.actions.map((a: any) => a.id)).toEqual(['add', 'take', 'void']);
    expect(man(r).scan.actions[0]).toMatchObject({ label: 'Plus', amount: { max: 5 } });
    const both = run(
      (d) => (scan(d).actions[0].amount = 2),
      (d) => (scan(d).actions[0].amount = 3),
    );
    expect(kinds(both)).toEqual({ 'scan.actions:actions/add/amount': 'both-changed' });
  });
  it('lookup is atomic, window K3, flags by input and n-th', () => {
    const r = run(
      (d) => (scan(d).flags[0].equals = ['b']),
      (d) => {
        scan(d).window = { lateMinutes: 9 };
        scan(d).flags[0].label = 'Gold';
        scan(d).lookup = { input: 'tier' };
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r).scan.window).toEqual({ lateMinutes: 9 });
    expect(man(r).scan.flags[0].label).toBe('Gold');
    expect(man(r).scan.lookup).toEqual({ input: 'tier' });
    const c = run(
      (d) => (scan(d).lookup = { input: 'a' }),
      (d) => (scan(d).lookup = { input: 'b' }),
    );
    expect(ids(c)).toEqual(['scan.meta:lookup']);
  });
});

describe('scan.display', () => {
  it('holder, photo, currency, notes merge per key', () => {
    const r = run(
      (d) => (disp(d).currency = 'EUR'),
      (d) => {
        disp(d).photo = { minRole: 'staff' };
        disp(d).notes = { staff: 'x' };
      },
    );
    expect(man(r).scan.display).toMatchObject({
      currency: 'EUR',
      photo: { minRole: 'staff' },
      notes: { staff: 'x' },
    });
  });
  it('header chips merge by id', () => {
    const r = run(
      (d) => (disp(d).header.title = 'O'),
      (d) => disp(d).header.chips.push({ id: 'c2', text: 'New' }),
    );
    expect(man(r).scan.display.header).toMatchObject({ title: 'O' });
    expect(man(r).scan.display.header.chips.map((c: any) => c.id)).toEqual(['c1', 'c2']);
    expect(
      ids(
        run(
          (d) => (disp(d).header.chips[0].text = 'A'),
          (d) => (disp(d).header.chips[0].text = 'B'),
        ),
      ),
    ).toEqual(['scan.display.header:display/header/chips/c1/text']);
  });
  it('variants by id with their own header', () => {
    const r = run(
      (d) => (disp(d).variants[0].name = 'Au'),
      (d) => {
        disp(d).variants[0].header.title = 'Shiny';
        disp(d).variants.push({
          id: 'v2',
          name: 'Silver',
          when: { input: 'tier', eq: 'b' },
          header: { title: 'S' },
        });
      },
    );
    expect(man(r).scan.display.variants.map((v: any) => v.id)).toEqual(['v1', 'v2']);
    expect(man(r).scan.display.variants[0]).toMatchObject({
      name: 'Au',
      header: { title: 'Shiny' },
    });
  });
  it('panels, rows and row items merge by id', () => {
    const r = run(
      (d) => (disp(d).panels[0].rows[0].text = 'O'),
      (d) => {
        disp(d).panels[0].title = 'T';
        disp(d).panels[0].rows[1].items[0].label = 'AA';
        disp(d).panels[0].rows.push({ id: 'r3', type: 'divider' });
      },
    );
    expect(r.status).toBe('clean');
    const p = man(r).scan.display.panels[0];
    expect(p.title).toBe('T');
    expect(p.rows.map((x: any) => x.id)).toEqual(['r1', 'r2', 'r3']);
    expect(p.rows[0].text).toBe('O');
    expect(p.rows[1].items[0].label).toBe('AA');
  });
  it('a row whose type differs is one atomic conflict', () => {
    const r = run(
      (d) => (disp(d).panels[0].rows[0] = { id: 'r1', type: 'divider' }),
      (d) => (disp(d).panels[0].rows[0].text = 'T'),
    );
    expect(kinds(r)).toEqual({ 'scan.display.panels:display/panels/p1/rows/r1': 'both-changed' });
  });
  it('customer: greet K3, chips a set, panel K3', () => {
    const r = run(
      (d) => (disp(d).customer.greet = false),
      (d) => {
        disp(d).customer.chips.push('c2');
        disp(d).customer.panel = null;
      },
    );
    expect(man(r).scan.display.customer).toEqual({
      greet: false,
      chips: ['c1', 'c2'],
      panel: null,
    });
  });
});

describe('scan.access', () => {
  it('plans by id, zones by value, suspend atomic, rules K3', () => {
    const r = run(
      (d) => {
        scan(d).access.plans[0].label = 'G';
        scan(d).access.plans[0].zones.push({ zone: 'c' });
      },
      (d) => {
        scan(d).access.plans[0].zones.shift();
        scan(d).access.plans.push({
          id: 'guest',
          label: 'Guest',
          kind: 'guest',
          zones: [{ zone: 'a' }],
        });
        scan(d).access.suspend = { input: 'tier', equals: ['x'] };
        scan(d).access.rules.reentryMinutes = null;
      },
    );
    expect(r.status).toBe('clean');
    const a = man(r).scan.access;
    expect(a.plans.map((p: any) => p.id)).toEqual(['gold', 'guest']);
    expect(a.plans[0]).toMatchObject({ label: 'G', zones: [{ zone: 'b' }, { zone: 'c' }] });
    expect(a.suspend).toEqual({ input: 'tier', equals: ['x'] });
    expect(a.rules).toEqual({ visitGapMinutes: 5, reentryMinutes: null });
    const c = run(
      (d) => (scan(d).access.plans[0].kind = 'timed'),
      (d) => (scan(d).access.plans[0].kind = 'guest'),
    );
    expect(ids(c)).toEqual(['scan.access:access/plans/gold/kind']);
  });
});
