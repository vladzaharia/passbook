import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { NOW, renderDoc, scopeOf } from './test-kit.ts';
import { hasVerdictWord } from './validate-rules.ts';

const DAY = 86_400_000;
const doc = (patch: Record<string, unknown> = {}): ScanDisplayDoc =>
  ({ v: 1, header: {}, ...patch }) as ScanDisplayDoc;
const field = (id: string, value = '{{inputs.seat}}', extra: object = {}) => ({
  id,
  type: 'field',
  label: 'Seat',
  value,
  ...extra,
});
const panel = (id: string, rows: object[], extra: object = {}) => ({ id, rows, ...extra });
const rowsOf = (display: ReturnType<typeof renderDoc>, index = 0) =>
  display.panels[index]?.rows ?? [];
const valid = (display: unknown) => expect(() => ScanDisplaySchema.parse(display)).not.toThrow();

describe('rows', () => {
  const scope = scopeOf(
    {
      seat: 'F12',
      blank: '',
      n: 3,
      stamps: 7,
      balance: 42.5,
      tier: 'VIP',
      section: '104',
      row: 'F',
      gate: 'C',
    },
    {
      scan: { input: 'balance', before: 42.5, after: 30.5, amount: 12 },
      history: {
        list: {
          visits: [],
          value: {
            balance: [
              { at: NOW - DAY, amount: -12, after: 42.5, where: 'Till 1', label: 'Charge' },
            ],
          },
        },
      },
      assets: { thumbnail: '/scan/asset/t.png' },
    },
  );
  const show = (rows: object[], extra: object = {}) =>
    renderDoc(doc({ panels: [panel('p_a', rows)], ...extra }), scope);

  it('field: value, strong, hide when empty and dash when asked', () => {
    const out = show([
      field('r_a', '{{inputs.seat}}', { strong: true }),
      field('r_b', '{{inputs.blank}}'),
      field('r_c', '{{inputs.blank}}', { whenEmpty: 'dash' }),
    ]);
    expect(rowsOf(out)).toMatchObject([
      { type: 'field', value: 'F12', strong: true },
      { type: 'field', value: '—' },
    ]);
    valid(out);
  });

  it('big, heading, note, divider and chips', () => {
    const out = show([
      { id: 'r_h', type: 'heading', text: 'Ticket', detail: '{{inputs.tier}}' },
      { id: 'r_b', type: 'big', label: 'Seat', value: '{{inputs.seat}}', unit: 'x', tone: 'teal' },
      { id: 'r_d', type: 'divider' },
      { id: 'r_n', type: 'note', text: 'Line one\nLine two', tone: 'attention' },
    ]);
    expect(rowsOf(out)).toMatchObject([
      { type: 'heading', text: 'Ticket', detail: 'VIP' },
      { type: 'big', value: 'F12', unit: 'x', tone: 'teal' },
      { type: 'divider' },
      { type: 'note', text: 'Line one\nLine two', tone: 'attention' },
    ]);
    valid(out);
  });

  it('columns: oneLine at every cap boundary and dashes for empties', () => {
    const cols = (size: string, values: string[]) =>
      show([
        {
          id: 'r_c',
          type: 'columns',
          size,
          items: values.map((value, i) => ({ id: `i_${i}`, label: 'L', value })),
        },
      ]);
    const oneLine = (size: string, values: string[]) =>
      (rowsOf(cols(size, values))[0] as { oneLine: boolean }).oneLine;
    expect(oneLine('big', ['12345678', '1'])).toBe(true);
    expect(oneLine('big', ['123456789', '1'])).toBe(true); // cut to 8 by the cap
    expect(oneLine('big', ['12345', '1', '1'])).toBe(true);
    expect(oneLine('big', ['123456', '1', '1'])).toBe(false);
    expect(oneLine('big', ['1234', '1', '1', '1'])).toBe(true);
    expect(oneLine('big', ['12345', '1', '1', '1'])).toBe(false);
    expect(oneLine('normal', ['123456789012', '1'])).toBe(true);
    expect(oneLine('normal', ['1234567890123', '1'])).toBe(false);
    expect(oneLine('normal', ['12345678', '1', '1', '1'])).toBe(true);
    expect(oneLine('normal', ['123456789', '1', '1'])).toBe(false);
    const blanks = cols('normal', ['{{inputs.blank}}', 'x']);
    expect(rowsOf(blanks)[0]).toMatchObject({ items: [{ value: '—' }, { value: 'x' }] });
    expect(rowsOf(cols('normal', ['{{inputs.blank}}', '{{inputs.blank}}']))).toEqual([]);
    valid(blanks);
  });

  it('list: pair one-line verdict and item conditions', () => {
    const list = (pair: boolean, text: string) =>
      show([
        {
          id: 'r_l',
          type: 'list',
          pair,
          items: [
            { id: 'i_a', icon: 'star', text },
            { id: 'i_b', icon: 'gem', text: 'Two', when: { path: 'inputs.tier', eq: 'Gold' } },
            { id: 'i_c', icon: 'key', text: 'Three', detail: '{{inputs.tier}}' },
          ],
        },
      ]);
    expect(rowsOf(list(true, 'Lounge'))[0] as { oneLine: boolean; items: unknown[] }).toMatchObject(
      { pair: true, oneLine: true },
    );
    expect(
      (rowsOf(list(true, 'A very long perk text'))[0] as { items: unknown[] }).items,
    ).toHaveLength(2);
    expect(rowsOf(list(true, 'A very long perk text'))[0]).toMatchObject({ oneLine: false });
    expect(rowsOf(list(false, 'Lounge'))[0]).toMatchObject({ pair: false, oneLine: false });
  });

  it('progress: caption, rewards, before and the goal from the take action', () => {
    const bar = (extra: object, s = scope) =>
      renderDoc(
        doc({
          panels: [
            panel('p_a', [{ id: 'r_p', type: 'progress', value: '{{inputs.stamps}}', ...extra }]),
          ],
        }),
        s,
      );
    expect(rowsOf(bar({ goal: 10, reward: 'Free coffee' }))[0]).toMatchObject({
      value: 7,
      goal: 10,
      style: 'stamps',
      rewards: 0,
      caption: '3 more for Free coffee',
    });
    const full = scopeOf(
      { stamps: '10' },
      { goals: { stamps: { goal: 10, reward: 'Free coffee' } } },
    );
    expect(rowsOf(bar({}, full))[0]).toMatchObject({ rewards: 1, caption: '1 reward ready' });
    expect(rowsOf(bar({ goal: 5 }, scopeOf({ stamps: 10 })))[0]).toMatchObject({
      rewards: 2,
      caption: '2 rewards ready',
    });
    expect(rowsOf(bar({ goal: 50 }))[0]).toMatchObject({ style: 'bar', caption: '7 of 50' });
    const moved = scopeOf({ stamps: 9 }, { scan: { input: 'stamps', before: 7, after: 9 } });
    expect(rowsOf(bar({ goal: 10 }, moved))[0]).toMatchObject({ before: 7 });
    expect(rowsOf(bar({ goal: 10 }))[0]).toMatchObject({ before: null });
    expect(rowsOf(bar({ goal: 10 }, scopeOf({ stamps: 'x' })))).toEqual([]);
  });

  it('money: formatting, change, low balance and pending', () => {
    const out = show([
      {
        id: 'r_m',
        type: 'money',
        label: 'Balance',
        amount: '{{inputs.balance}}',
        currency: 'USD',
        lowBelow: 50,
        pending: ['charge'],
      },
    ]);
    expect(rowsOf(out)[0]).toMatchObject({
      amount: 42.5,
      currency: 'USD',
      text: '$42.50',
      before: 42.5,
      change: -12,
      low: true,
      pending: ['charge'],
    });
    valid(out);
    expect(
      rowsOf(
        show([{ id: 'r_m', type: 'money', amount: '{{inputs.balance}}' }], { currency: 'usd' }),
      )[0],
    ).toMatchObject({ currency: 'USD' });
  });

  it('history: labels, formatting, and one "Changed elsewhere" row', () => {
    const out = renderDoc(
      doc({
        panels: [
          panel('p_a', [
            {
              id: 'r_h',
              type: 'history',
              source: 'value',
              input: 'balance',
              show: ['amount', 'when', 'where', 'action'],
            },
          ]),
        ],
      }),
      { ...scope, inputs: { ...(scope.inputs as object), balance: 40 } },
    );
    const items = (rowsOf(out)[0] as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      elsewhere: true,
      label: 'Changed elsewhere',
      amount: '−2.5',
      when: null,
    });
    expect(items[1]).toMatchObject({
      amount: '−12',
      when: '1 day ago',
      where: 'Till 1',
      label: 'Charge',
    });
    valid(out);
    const none = show([{ id: 'r_h', type: 'history', source: 'visits' }]);
    expect(rowsOf(none)[0]).toMatchObject({ items: [], empty: 'No visits yet.' });
    expect(rowsOf(show([{ id: 'r_h', type: 'history', source: 'scans' }]))).toEqual([]);
  });

  it('image: a url from the server assets, else the row drops', () => {
    expect(
      rowsOf(show([{ id: 'r_i', type: 'image', source: 'thumbnail', title: 'Pass' }]))[0],
    ).toMatchObject({ url: '/scan/asset/t.png', alt: 'Pass' });
    expect(rowsOf(show([{ id: 'r_i', type: 'image', source: 'strip' }]))).toEqual([]);
  });
});

describe('safety', () => {
  const scope = scopeOf({ seat: 'F12', secret: 'x' }, { scan: { direction: 'in' } });
  const full = doc({
    holder: '{{inputs.seat}}',
    header: {
      icon: 'crown',
      title: 'Welcome',
      subtitle: 'Meta',
      chips: [{ id: 'c_a', text: 'VIP', tone: 'gold' }],
    },
    notes: { staff: 'Wristbands at C', refused: 'See the box office' },
    panels: [panel('p_a', [field('r_a')])],
  });

  it('ok keeps the custom icon and title; heads_up and ready drop both', () => {
    const ok = renderDoc(full, scope, { screen: 'ok' });
    expect(ok.header).toMatchObject({ icon: 'crown', title: 'Welcome', meta: 'Meta' });
    for (const screen of ['heads_up', 'ready'] as const) {
      const out = renderDoc(full, scope, { screen });
      expect(out.header).toMatchObject({ icon: null, title: null, meta: 'Meta' });
      expect(out.header.chips).toHaveLength(1);
      expect(out.panels).toHaveLength(1);
    }
  });

  it('an exit ignores the custom icon and title', () => {
    const out = renderDoc(full, scopeOf({}, { scan: { direction: 'out' } }), { screen: 'ok' });
    expect(out.header).toMatchObject({ icon: null, title: null });
  });

  it('refused shows nothing but the refused note and the holder', () => {
    const out = renderDoc(full, scope, { screen: 'refused' });
    expect(out.panels).toEqual([]);
    expect(out.header).toEqual({ icon: null, title: null, titleLines: 1, meta: null, chips: [] });
    expect(out.notes).toEqual({ staff: null, refused: 'See the box office' });
    expect(out.identity.holder).toBe('F12');
    valid(out);
  });

  it('the holder is never empty for a known pass', () => {
    expect(renderDoc(doc({ holder: '{{inputs.missing}}' }), scopeOf()).identity.holder).toBe(
      'Anna Meyer',
    );
    expect(renderDoc(doc(), { inputs: {} }).identity.holder).toBe('Pass');
    expect(renderDoc(doc(), { inputs: {}, pass: { templateName: 'Gala' } }).identity.holder).toBe(
      'Gala',
    );
    expect(
      renderDoc(doc({ holder: '{{inputs.n}}' }), scopeOf({ n: 'Jo Ann' })).identity,
    ).toMatchObject({ holder: 'Jo Ann', initials: 'JA' });
  });

  it('no output holds "{{", even from a value that does', () => {
    const out = renderDoc(
      doc({
        holder: '{{inputs.n}}',
        header: { subtitle: '{{inputs.n}}' },
        panels: [panel('p_a', [field('r_a', '{{inputs.n}}'), field('r_b', 'ok {{inputs.n}}')])],
      }),
      scopeOf({ n: 'a {{b}} c' }),
    );
    expect(JSON.stringify(out)).not.toContain('{{');
  });

  it('terminals get no panels; the photo needs the role', () => {
    const photo = doc({ photo: { minRole: 'desk' }, panels: [panel('p_a', [field('r_a')])] });
    expect(renderDoc(photo, scope, { terminal: true }).panels).toEqual([]);
    expect(renderDoc(photo, scope, { role: 'door' }).identity.photo).toBeNull();
    expect(
      renderDoc(photo, scopeOf({}, { assets: { photo: '/p.jpg' } }), { role: 'desk' }).identity
        .photo,
    ).toEqual({ url: '/p.jpg', alt: 'Photo of Anna Meyer' });
    expect(renderDoc(photo, scope, { role: 'desk' }).identity.photo).toEqual({
      url: null,
      alt: 'Photo of Anna Meyer',
    });
  });
});

describe('the band title', () => {
  const title = (
    holder: string,
    source = 'Welcome back, {{holder.firstName}}',
    screen: 'ok' | 'heads_up' = 'ok',
  ) =>
    renderDoc(doc({ holder: '{{inputs.n}}', header: { title: source } }), scopeOf({ n: holder }), {
      screen,
    });

  it('renders a plausible name on two lines', () => {
    for (const [name, text] of [
      ['Maya', 'Welcome back, Maya'],
      ['José', 'Welcome back, José'],
      ["O'Neil", "Welcome back, O'Neil"],
      ['Anne-Marie', 'Welcome back, Anne-Marie'],
      ['李小龙', 'Welcome back, 李小龙'],
    ] as const)
      expect(title(name).header).toMatchObject({ title: text, titleLines: 2 });
    expect(title('Maya Lopez', 'Welcome back, {{holder.name}}').header.title).toBe(
      'Welcome back, Maya Lopez',
    );
  });

  it('gives the system headline for anything that does not read as a name', () => {
    for (const name of [
      'Refunded',
      'not valid',
      'VOID 2',
      'Ana Maria de la Cruz',
      'https://x.io',
      'Maya‮ txt',
      'Access denied',
      'ALREADY',
    ])
      expect(title(name, 'Hi, {{holder.name}}').header.title, name).toBeNull();
  });

  it('uses the first word for firstName and shows nothing on heads_up', () => {
    expect(title('Maya Lopez').header.title).toBe('Welcome back, Maya');
    expect(title('Maya', 'Welcome back, {{holder.firstName}}', 'heads_up').header.title).toBeNull();
  });

  it('truncates the name, never the literal, to fit 28', () => {
    const out = title('Wolfeschlegelstein', 'Welcome back, {{holder.name}}');
    expect(out.header.title).toBe('Welcome back, Wolfeschlegel…');
    expect(Array.from(out.header.title ?? '')).toHaveLength(28);
  });

  it('a literal title is one line when short', () => {
    expect(renderDoc(doc({ header: { title: 'Welcome back' } })).header).toMatchObject({
      title: 'Welcome back',
      titleLines: 1,
    });
  });

  it('property: 1,000 names never put a verdict word or a digit in a title', () => {
    const alphabet = [
      'Maya',
      'refunded',
      'Void',
      '2',
      'denied',
      'Jo',
      "O'Neil",
      'x1',
      ' ',
      ' ',
      '-',
      '.',
      'not',
      'valid',
      'STOP',
      'é',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 1000; i++) {
      const name = Array.from(
        { length: 1 + Math.floor(next() * 5) },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join('');
      const shown = title(name, 'Hi, {{holder.name}}').header.title;
      if (shown === null) continue;
      expect(shown, name).not.toMatch(/\d/);
      expect(hasVerdictWord(shown), name).toBe(false);
    }
  });
});

describe('variants, roles and panels', () => {
  const variants = [
    {
      id: 'v_vip',
      name: 'VIP',
      when: { path: 'inputs.tier', eq: 'VIP' },
      header: { icon: 'crown', title: null, chips: [{ id: 'c_v', text: 'VIP', tone: 'gold' }] },
    },
    {
      id: 'v_any',
      name: 'Any',
      when: { path: 'inputs.tier', empty: false },
      header: { subtitle: 'Member' },
    },
  ];
  const base = {
    header: {
      title: 'Hello',
      subtitle: 'Base',
      chips: [{ id: 'c_b', text: 'Base', tone: 'teal' }],
    },
    variants,
  };

  it('first match wins; set slots override, null clears, unset fall through', () => {
    const out = renderDoc(doc(base), scopeOf({ tier: 'VIP' }));
    expect(out.variant).toBe('v_vip');
    expect(out.header).toMatchObject({ icon: 'crown', title: null, meta: 'Base' });
    expect(out.header.chips.map((c) => c.text)).toEqual(['VIP']);
    const second = renderDoc(doc(base), scopeOf({ tier: 'Gold' }));
    expect(second.variant).toBe('v_any');
    expect(second.header).toMatchObject({ title: 'Hello', meta: 'Member' });
    expect(renderDoc(doc(base), scopeOf({})).variant).toBeNull();
  });

  it('minRole removes elements before anything is evaluated', () => {
    const d = doc({
      header: { chips: [{ id: 'c_a', text: 'Desk', tone: 'teal', minRole: 'desk' }] },
      panels: [
        panel(
          'p_a',
          [
            field('r_a', '{{inputs.seat}}', { minRole: 'manager' }),
            field('r_b', '{{inputs.seat}}'),
          ],
          { minRole: 'desk' },
        ),
      ],
    });
    const s = scopeOf({ seat: 'F12' });
    expect(renderDoc(d, s, { role: 'door' }).panels).toEqual([]);
    expect(renderDoc(d, s, { role: 'door' }).header.chips).toEqual([]);
    expect(rowsOf(renderDoc(d, s, { role: 'desk' }))).toHaveLength(1);
    expect(rowsOf(renderDoc(d, s, { role: 'manager' }))).toHaveLength(2);
  });

  it('a desk-only value in the meta line gives the system line for Door', () => {
    const d = doc({ header: { subtitle: '{{inputs.tier}}' } });
    const scopeForDoor = scopeOf({}); // the server removed the desk-only input
    expect(renderDoc(d, scopeForDoor, { role: 'door' }).header.meta).toBeNull();
    expect(renderDoc(d, scopeOf({ tier: 'Gold' }), { role: 'desk' }).header.meta).toBe('Gold');
  });

  it('panels: on, actions, when, the empty drop, the 2 cut and the 1 cut', () => {
    const d = doc({
      panels: [
        panel('p_ok', [field('r_1')], { on: ['ok'] }),
        panel('p_ready', [field('r_2')], { on: ['ready'] }),
        panel('p_act', [field('r_3')], { actions: ['redeem'] }),
        panel('p_when', [field('r_4')], { when: { path: 'inputs.seat', eq: 'Z' } }),
        panel('p_empty', [field('r_5', '{{inputs.nope}}')]),
        panel('p_last', [field('r_6')]),
      ],
    });
    const s = scopeOf({ seat: 'F12' });
    const ids = (o: ReturnType<typeof renderDoc>) => o.panels.map((p) => p.id);
    expect(ids(renderDoc(d, s, { screen: 'ok', actionId: 'redeem' }))).toEqual(['p_ok', 'p_act']);
    expect(ids(renderDoc(d, s, { screen: 'ok', actionId: 'add' }))).toEqual(['p_ok', 'p_last']);
    expect(ids(renderDoc(d, s, { screen: 'ready' }))).toEqual(['p_ready', 'p_act']);
    expect(ids(renderDoc(d, s, { screen: 'ready', amountOpen: true }))).toEqual(['p_ready']);
  });

  it('cuts trailing rows to the screen, deterministically, never the first row', () => {
    const seat = { id: 'r_s', type: 'big', value: '{{inputs.seat}}' };
    const d = doc({ panels: [panel('p_t', [seat, field('r_a'), field('r_b'), field('r_c')])] });
    const s = scopeOf({ seat: 'F12' });
    expect(rowsOf(renderDoc(d, s, { screen: 'ok' }))).toHaveLength(4);
    expect(rowsOf(renderDoc(d, s, { screen: 'heads_up' })).map((r) => r.id)).toEqual([
      'r_s',
      'r_a',
    ]);
    const staff = renderDoc({ ...d, notes: { staff: 'Note' } }, s, { screen: 'heads_up' });
    expect(rowsOf(staff).map((r) => r.id)).toEqual(['r_s']);
    expect(renderDoc(d, s, { screen: 'heads_up' })).toEqual(
      renderDoc(d, s, { screen: 'heads_up' }),
    );
  });

  it('a custom title and a photo cost units on ok', () => {
    const d = doc({
      photo: {},
      header: { title: 'Welcome back' },
      panels: [panel('p_a', [field('r_a'), field('r_b'), field('r_c'), field('r_d')])],
    });
    expect(rowsOf(renderDoc(d, scopeOf({ seat: 'F12' }))).length).toBeLessThan(4);
  });

  it('never exposes pass.externalId to Door', () => {
    const d = doc({ panels: [panel('p_a', [field('r_a', '{{pass.externalId}}')])] });
    const s = scopeOf({}, { pass: { title: 'A', externalId: 'ext-1' } });
    expect(renderDoc(d, s, { role: 'door' }).panels).toEqual([]);
    expect(rowsOf(renderDoc(d, s, { role: 'desk' }))).toHaveLength(1);
  });

  it('throws its own marked error for an unknown screen or version', () => {
    expect(() => renderDoc(doc(), scopeOf(), { screen: 'nope' as never })).toThrow(
      'scan-display:render',
    );
    expect(() => renderDoc({ v: 2, header: {} } as never)).toThrow('scan-display');
  });
});

describe('time', () => {
  it('formats in the actor zone and locale', () => {
    const d = doc({ panels: [panel('p_a', [field('r_a', '{{inputs.at|time}}')])] });
    const s = scopeOf({ at: NOW });
    const eastern = rowsOf(renderDoc(d, s))[0] as { value: string };
    expect(eastern.value).toBe('1:00 PM');
  });
});
