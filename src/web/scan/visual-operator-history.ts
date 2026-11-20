/** A person's history and staff notes for the visual gallery: lines over three weeks, notes in both tones. */
import type {
  HistoryFilter,
  HistoryItem,
  HistoryPage,
  PassNote,
} from '../../shared/contracts/scan-history.ts';
import { GALLERY_NOW } from './visual-operator-record.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const at = (days: number, min = 0) => GALLERY_NOW - days * DAY - min * MIN;
const item = (
  n: number,
  when: number,
  event: HistoryItem['event'],
  over: Partial<HistoryItem> = {},
): HistoryItem => ({
  id: `01900000-0000-7000-8000-0000000007${n.toString().padStart(2, '0')}`,
  at: when,
  event,
  reason: null,
  label: null,
  place: 'Front desk',
  staff: null,
  amount: null,
  ...over,
});

/** The newest lines agree with what the record above them says just happened. */
const HEAD: Record<string, HistoryItem[]> = {
  ok: [item(1, at(0, 1), 'checked_in', { staff: 'Theo B.', label: 'Check in' })],
  record: [item(90, at(0, 17), 'checked_out', { place: 'Turnstile A' })],
  refusal: [
    item(90, at(0, 3), 'refused', { reason: 'guest_visits_used' }),
    item(91, at(0, 80), 'checked_out', { place: 'Turnstile A' }),
  ],
};
const HEAD_OF: Record<string, string> = {
  family: 'ok',
  photo: 'ok',
  manager: 'refusal',
  viewonly: 'refusal',
};

const LINES: HistoryItem[] = [
  item(2, at(1, 40), 'checked_out', { place: 'Turnstile A' }),
  item(3, at(1, 120), 'note', { place: null, staff: 'Jonas W.' }),
  item(4, at(1, 130), 'checked_in', { place: 'Turnstile A' }),
  item(5, at(3, 30), 'checked_out', { place: 'Turnstile A' }),
  item(6, at(3, 55), 'let_in', {
    staff: 'Ana R.',
    reason: 'already_done',
    place: 'Turnstile A',
  }),
  item(7, at(3, 56), 'held', { reason: 'already_done', place: 'Turnstile A' }),
  item(8, at(6, 10), 'undone', { staff: 'Theo B.' }),
  item(9, at(8, 15), 'value', { label: 'Add stamp', amount: 1, staff: 'Theo B.' }),
  item(10, at(9, 5), 'refused', { reason: 'guest_visits_used', place: 'Pool gate' }),
  item(11, at(12, 22), 'checked_in', { place: 'Studio door' }),
  item(12, at(14, 18), 'scanned', { place: 'Scanner' }),
];
const OLDER: HistoryItem[] = [
  item(13, at(19, 12), 'checked_out', { place: 'Turnstile A' }),
  item(14, at(19, 70), 'checked_in', { place: 'Turnstile A' }),
];

const keep: Record<HistoryFilter, (i: HistoryItem) => boolean> = {
  all: () => true,
  visits: (i) => !['value', 'note'].includes(i.event),
  changes: (i) => ['value', 'note'].includes(i.event),
};

/** Ten lines, then the older rest behind a cursor. A Door-role session has no `changes`. */
export function historyPage(
  scenario: string,
  query: { filter: HistoryFilter; cursor?: string | null },
): HistoryPage {
  const head = HEAD[HEAD_OF[scenario] ?? scenario] ?? [];
  const all = [...head, ...LINES, ...OLDER].filter(keep[query.filter]);
  const from = query.cursor ? Number(query.cursor) : 0;
  const items = all.slice(from, from + 10);
  const next = from + 10;
  return { items, nextCursor: next < all.length ? String(next) : null };
}

export const NOTES: PassNote[] = [
  {
    id: '01900000-0000-7000-8000-000000000801',
    at: at(1, 120),
    body: "Chidi's climbing waiver is still unsigned. Ask Maya.",
    by: 'Jonas W.',
  },
  {
    id: '01900000-0000-7000-8000-000000000802',
    at: at(20),
    body: 'Prefers the side door. Knee brace, no stairs.',
    by: 'Ana R.',
  },
];
