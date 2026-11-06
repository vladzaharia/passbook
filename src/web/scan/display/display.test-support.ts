import type {
  ScanChip,
  ScanDisplay,
  ScanDisplayPanel,
  ScanDisplayRow,
} from '../../../shared/contracts/scan-display.ts';

/** The widest text each cap allows, for no-overflow checks. */
export const long = (n: number) => 'W'.repeat(n);

export const chip = (over: Partial<ScanChip> = {}): ScanChip => ({
  id: 'c1',
  text: long(16),
  tone: 'gold',
  icon: 'crown',
  ...over,
});

/** One of every row type at its caps (DM 1.6). */
export const maxRows: ScanDisplayRow[] = [
  { type: 'heading', id: 'h', text: long(24), detail: long(24) },
  { type: 'field', id: 'f', label: long(20), value: long(48), icon: 'ticket', strong: true },
  { type: 'big', id: 'b', label: long(20), value: long(12), unit: long(12), tone: 'violet' },
  {
    type: 'columns',
    id: 'cb',
    size: 'big',
    oneLine: false,
    items: [
      { label: long(12), value: long(8) },
      { label: long(12), value: long(8) },
      { label: long(12), value: long(8) },
      { label: long(12), value: long(8) },
    ],
  },
  {
    type: 'columns',
    id: 'cn',
    size: 'normal',
    oneLine: true,
    items: [
      { label: 'A', value: 'B' },
      { label: long(12), value: '' },
    ],
  },
  {
    type: 'progress',
    id: 'p',
    value: 9,
    goal: 10,
    before: 7,
    style: 'stamps',
    icon: 'coffee',
    rewards: 0,
    caption: '1 more for Free coffee',
  },
  {
    type: 'progress',
    id: 'p2',
    value: 40,
    goal: 100,
    before: null,
    style: 'bar',
    icon: null,
    rewards: 1,
    caption: '60 more for a trip',
  },
  {
    type: 'money',
    id: 'm',
    label: long(20),
    amount: 30.5,
    currency: 'USD',
    text: '$30.50',
    before: 42.5,
    change: -12,
    low: true,
    pending: [],
  },
  {
    type: 'history',
    id: 'hi',
    items: [
      {
        at: 1,
        when: 'Today 6:10 PM',
        amount: '−$12.00',
        delta: null,
        where: 'Main desk',
        label: 'Charge',
        elsewhere: false,
      },
      { at: 2, when: null, amount: null, delta: 2, where: null, label: null, elsewhere: true },
    ],
    empty: null,
  },
  {
    type: 'image',
    id: 'im',
    source: 'thumbnail',
    url: '/api/v1/x.png',
    alt: 'Logo',
    title: long(32),
    detail: long(40),
  },
  { type: 'chips', id: 'ch', items: [chip(), chip({ id: 'c2', tone: 'teal' })] },
  {
    type: 'list',
    id: 'l',
    pair: true,
    oneLine: false,
    items: [
      { id: 'l1', icon: 'armchair', text: long(32), detail: long(24) },
      { id: 'l2', icon: 'utensils', text: 'Dinner', detail: null },
    ],
  },
  { type: 'note', id: 'n', text: long(140), tone: 'attention', icon: 'info' },
  { type: 'divider', id: 'd' },
];

let panelSeq = 0;
export const panel = (
  rows: ScanDisplayRow[],
  over: Partial<ScanDisplayPanel> = {},
): ScanDisplayPanel => ({
  id: `panel${++panelSeq}`,
  kind: 'custom',
  title: long(24),
  icon: 'star',
  tone: 'violet',
  rows,
  ...over,
});

export function display(panels: ScanDisplayPanel[], over: Partial<ScanDisplay> = {}): ScanDisplay {
  return {
    v: 1,
    screen: 'ok',
    templateVersion: 'v1',
    variant: null,
    identity: { holder: 'Anna Meyer', initials: 'AM', photo: null },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels,
    notes: { staff: null, refused: null },
    ...over,
  };
}

/** `maxRows` in panels of at most 6 rows (the contract's cap). */
export const maxPanels = (): ScanDisplayPanel[] => [
  panel(maxRows.slice(0, 6)),
  panel(maxRows.slice(6, 12)),
  panel(maxRows.slice(12)),
];
