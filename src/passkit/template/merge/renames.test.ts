import { describe, expect, it } from 'vitest';
import { applyResolutions } from './apply.ts';
import { mergePackages } from './index.ts';
import { baseDoc, edit, ids, kinds, man, run, sha, style } from './merge-test-fixtures.ts';
import { renameIn } from './renames.ts';

const m = (d: any) => d.manifest;
const renameField = (from: string, to: string) => (d: any) => {
  for (const f of d.passJson.generic.secondaryFields) if (f.key === from) f.key = to;
  for (const b of m(d).bindings) if (b.to.field === from) b.to.field = to;
};
const renameInput = (from: string, to: string) => (d: any) => {
  const p = m(d).inputs.properties;
  m(d).inputs.properties = Object.fromEntries(
    Object.entries(p).map(([k, v]) => [k === from ? to : k, v]),
  );
  for (const b of m(d).bindings) b.value = b.value.replace(`{{${from}}}`, `{{${to}}}`);
  m(d).display.subtitle = m(d).display.subtitle.replace(`{{${from}}}`, `{{${to}}}`);
  m(d).scan.flags[0].input = to;
  m(d).scan.access.input.plan = to;
  m(d).scan.display.variants[0].when.input = to;
};

describe('renames', () => {
  it('a clean field rename applies and reaches ours-only references', () => {
    const r = run(
      (d) => m(d).bindings.push({ to: { field: 'tier', prop: 'label' }, value: 'Level' }),
      renameField('tier', 'level'),
    );
    expect(r.status).toBe('clean');
    expect(r.renames).toEqual([{ kind: 'field', from: 'tier', to: 'level', applied: true }]);
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['level', 'pts', 'since']);
    expect(man(r).bindings.map((b: any) => b.to.field)).toEqual(['name', 'level', 'pts', 'level']);
    expect(r.theirs).toContainEqual({ part: 'fields', path: ['tier'], op: 'rename' });
  });
  it('a clean input rename rewrites keys, expressions, conditions and ours-only references', () => {
    const r = run(
      (d) => {
        m(d).display.search.push('tier');
        m(d).bindings.push({
          to: { field: 'name' },
          value: 'Is {{tier}}',
          when: { input: 'tier', eq: 'a' },
        });
        m(d).sample.tier = 'a';
        m(d).inputs.required.push('tier');
        m(d).stamps.input = 'tier';
      },
      renameInput('tier', 'level'),
    );
    expect(r.status).toBe('clean');
    const x = man(r);
    expect(Object.keys(x.inputs.properties)).toEqual(['name', 'level', 'pts']);
    expect(x.display.search).toEqual(['name', 'level']);
    expect(x.bindings.at(-1)).toEqual({
      to: { field: 'name' },
      value: 'Is {{level}}',
      when: { input: 'level', eq: 'a' },
    });
    expect(x.sample).toEqual({ name: 'Ada', level: 'a' });
    expect(x.inputs.required).toEqual(['name', 'level']);
    expect(x.stamps.input).toBe('level');
    expect(x.scan.flags[0].input).toBe('level');
    expect(x.scan.access.input.plan).toBe('level');
    expect(x.display.subtitle).toBe('{{level}}');
  });
  it('does not touch pass.* paths or lookups tables named like the input', () => {
    const r = run(
      (d) => (m(d).display.status = '{{pass.tier}} {{lookups.tier[tier]}}'),
      renameInput('tier', 'level'),
    );
    expect(man(r).display.status).toBe('{{pass.tier}} {{lookups.tier[level]}}');
  });
  it('an input rename rewrites scan.actions[].input, ours-only actions included', () => {
    const r = run(
      (d) =>
        m(d).scan.actions.push({
          id: 'bonus',
          label: 'Bonus',
          kind: 'add',
          input: 'pts',
          amount: 2,
        }),
      (d) => {
        const p = m(d).inputs.properties;
        m(d).inputs.properties = Object.fromEntries(
          Object.entries(p).map(([k, v]) => [k === 'pts' ? 'points' : k, v]),
        );
        for (const x of m(d).scan.actions) x.input = 'points';
      },
    );
    expect(r.renames).toContainEqual({ kind: 'input', from: 'pts', to: 'points', applied: true });
    expect(man(r).scan.actions.map((x: any) => x.input)).toEqual(['points', 'points', 'points']);
  });
  it('rename against a modify is a conflict that can take theirs rename with ours edits', () => {
    const o = (d: any) => (d.passJson.generic.secondaryFields[0].label = 'Mine');
    const base = baseDoc();
    const r = mergePackages(base, edit(base, o), edit(base, renameField('tier', 'level')));
    expect(kinds(r)).toEqual({ 'fields:tier': 'rename-modify' });
    expect(r.renames[0]?.applied).toBe(false);
    expect(style(r).secondaryFields[0]).toMatchObject({ key: 'tier', label: 'Mine' });
    const picked = applyResolutions(base, edit(base, o), edit(base, renameField('tier', 'level')), {
      'fields:tier': 'theirs',
    });
    expect((picked.passJson as any).generic.secondaryFields[0]).toMatchObject({
      key: 'level',
      label: 'Mine',
    });
    expect((picked.manifest as any).bindings[1].to.field).toBe('level');
  });
  it('without a one-to-one match it is a delete plus adds', () => {
    const split = (d: any) => {
      const [f] = d.passJson.generic.secondaryFields.splice(0, 1);
      d.passJson.generic.secondaryFields.push({ ...f, key: 'a1' }, { ...f, key: 'a2' });
    };
    const r = run(undefined, split);
    expect(r.renames).toEqual([]);
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['pts', 'since', 'a1', 'a2']);
  });
  it('a rename also needs the same group for fields', () => {
    const moveAndRename = (d: any) => {
      const [f] = d.passJson.generic.secondaryFields.splice(0, 1);
      d.passJson.generic.backFields.push({ ...f, key: 'level' });
    };
    expect(run(undefined, moveAndRename).renames).toEqual([]);
  });
  it('renames scan actions, plans, panels, chips and stamp art with their references', () => {
    const t = (d: any) => {
      const s = m(d).scan;
      s.actions[0].id = 'plus';
      s.display.panels[0].actions = ['plus'];
      s.access.plans[0].id = 'vip';
      s.display.header.chips[0].id = 'tierChip';
      s.display.customer.chips = ['tierChip'];
      m(d).stamps.art.filled = 'stamps/full.png';
      d.files['stamps/full.png'] = d.files['stamps/filled.png'];
      delete d.files['stamps/filled.png'];
    };
    const r = run((d) => (m(d).stamps.art.reward = 'stamps/filled.png'), t);
    expect(r.status).toBe('clean');
    expect(r.renames.map((x) => `${x.kind}:${x.from}>${x.to}`)).toEqual([
      'action:add>plus',
      'art:stamps/filled.png>stamps/full.png',
      'chip:c1>tierChip',
      'plan:gold>vip',
    ]);
    const s = man(r).scan;
    expect(s.actions[0].id).toBe('plus');
    expect(s.display.panels[0]).toMatchObject({ id: 'p1', actions: ['plus'] });
    expect(s.display.customer).toMatchObject({ panel: 'p1', chips: ['tierChip'] });
    expect(s.access.plans[0].id).toBe('vip');
    expect(man(r).stamps.art).toEqual({
      filled: 'stamps/full.png',
      empty: 'stamps/empty.png',
      reward: 'stamps/full.png',
    });
    expect(Object.keys(r.merged.files)).toContain('stamps/full.png');
    expect(r.merged.files['stamps/full.png']?.sha1).toBe(sha('filled'));
  });
  it('renames a row and a chip inside a row', () => {
    const r = run(undefined, (d) => {
      const rows = m(d).scan.display.panels[0].rows;
      rows[0].id = 'greeting';
      rows.push({ id: 'r9', type: 'chips', items: [{ id: 'k1', text: 'x' }] });
    });
    expect(r.renames).toEqual([{ kind: 'row', from: 'r1', to: 'greeting', applied: true }]);
  });
  it('renames a panel and the customer reference to it', () => {
    const r = run(undefined, (d) => {
      m(d).scan.display.panels[0].id = 'main';
      m(d).scan.display.customer.panel = 'main';
    });
    expect(r.renames).toEqual([{ kind: 'panel', from: 'p1', to: 'main', applied: true }]);
    expect(man(r).scan.display.customer.panel).toBe('main');
  });
  it('a rename of an entity ours deleted does nothing', () => {
    const r = run((d) => d.passJson.generic.secondaryFields.shift(), renameField('tier', 'level'));
    expect(r.renames).toEqual([{ kind: 'field', from: 'tier', to: 'level', applied: false }]);
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['pts', 'since']);
  });
});

const SINCE_REF = 'references:field/since/bindings/{"field":"since"}#0';

describe('reference check', () => {
  it('flags a reference the merge broke: theirs refers to what ours deleted', () => {
    const r = run(
      (d) => d.passJson.generic.secondaryFields.pop(),
      (d) => m(d).bindings.push({ to: { field: 'since' }, value: 'x' }),
    );
    expect(r.conflicts.map((c) => [c.id, c.kind])).toEqual([[SINCE_REF, 'reference']]);
  });
  it('flags ours refs when theirs deletes what ours kept and theirs is taken', () => {
    const base = baseDoc();
    const o = edit(base, (d) => {
      d.passJson.generic.secondaryFields[2].label = 'Mine';
      m(d).bindings.push({ to: { field: 'since' }, value: 'x' });
    });
    const t = edit(base, (d) => d.passJson.generic.secondaryFields.pop());
    const r = mergePackages(base, o, t);
    expect(r.conflicts.map((c) => c.kind)).toEqual(['modify-delete']);
    const picked = mergePackages(base, o, t, { picks: { 'fields:since': 'theirs' } });
    expect(picked.conflicts.map((c) => c.id)).toEqual([SINCE_REF]);
  });
  it('ignores references that were already broken and unresolved in both', () => {
    const r = run(
      (d) => m(d).bindings.push({ to: { field: 'ghost' }, value: 'x' }),
      (d) => (m(d).description = 'T'),
    );
    expect(r.status).toBe('clean');
  });
});

describe('invalid, noop and two-way', () => {
  it('a schema gap with no upgrader is one typed conflict and merges nothing', () => {
    const r = run(undefined, (d) => (m(d).schema = 2));
    expect(r.conflicts).toMatchObject([
      { id: 'manifest.meta:schema', kind: 'schema_upgrade_missing' },
    ]);
    expect(r.merged.manifest.schema).toBe(1);
  });
  it('a scan.display.v or wallets.schema gap with no upgrader freezes that part only', () => {
    const r = run(
      (d) => (m(d).description = 'O'),
      (d) => {
        m(d).scan.display.v = 2;
        m(d).scan.display.holder = 'changed';
        m(d).wallets.schema = 2;
        m(d).display.title = 'T';
      },
    );
    expect(kinds(r)).toEqual({
      'scan.display:v': 'schema_upgrade_missing',
      'wallets:schema': 'schema_upgrade_missing',
    });
    expect(man(r).scan.display).toEqual(man(run()).scan.display);
    expect(man(r)).toMatchObject({ description: 'O', display: { title: 'T' } });
  });
  it('a blueprint flag or org change is a no-op', () => {
    const base = baseDoc();
    const o = edit(base, (d) => (m(d).description = 'Mine'));
    const t = edit(base, (d) => {
      m(d).blueprint = true;
      m(d).org = { slug: 's', name: 'S' };
    });
    const r = mergePackages(base, o, t);
    expect(r.status).toBe('clean');
    expect(r.theirs).toEqual([]);
    expect(r.merged).toEqual(mergePackages(base, o, base).merged);
  });
  it('wallets-only and scan.display-only upstream changes show as their own parts', () => {
    const r = run(undefined, (d) => {
      m(d).wallets.google.omit.push('z');
      m(d).scan.display.currency = 'EUR';
    });
    expect([...new Set(r.theirs.map((c) => c.part))]).toEqual(['scan.display', 'wallets']);
  });
  it('two-way: every difference conflicts and equal values are clean', () => {
    const r = run(
      (d) => (m(d).description = 'O'),
      (d) => (m(d).display.title = 'T'),
      true,
    );
    expect(ids(r)).toEqual(['display:title', 'manifest.meta:description']);
    expect(Object.values(kinds(r))).toEqual(['both-changed', 'both-changed']);
    expect(run(undefined, undefined, true).status).toBe('clean');
    expect(
      run(
        (d) => (m(d).description = 'S'),
        (d) => (m(d).description = 'S'),
        true,
      ).status,
    ).toBe('clean');
  });
  it('resolutions: theirs, custom value, ours', () => {
    const base = baseDoc();
    const [o, t] = [
      edit(base, (d) => (m(d).description = 'O')),
      edit(base, (d) => (m(d).description = 'T')),
    ];
    const id = 'manifest.meta:description';
    expect((applyResolutions(base, o, t, { [id]: 'theirs' }).manifest as any).description).toBe(
      'T',
    );
    expect(
      (applyResolutions(base, o, t, { [id]: { value: 'X' } }).manifest as any).description,
    ).toBe('X');
    expect((applyResolutions(base, o, t, { [id]: 'ours' }).manifest as any).description).toBe('O');
    expect(mergePackages(base, o, t, { picks: { [id]: 'theirs' } }).conflicts).toEqual([]);
  });

  it('rewrites scan.window inputs and nothing named alike', () => {
    const d = baseDoc();
    m(d).scan.window = { from: 'level', until: 'level2' };
    const x = m(renameIn(d, { kind: 'input', from: 'level', to: 'tier' }));
    expect(x.scan.window).toEqual({ from: 'tier', until: 'level2' });
  });
});
