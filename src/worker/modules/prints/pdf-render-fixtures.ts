import { type PaperKind, type PaperSize, resolvePaper } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { PrintSheet } from './pdf-render.ts';

export const SAMPLE_CODE = 'PK7QM3XRTWA2D5HJN6BV4CEYLZG';

/** An event ticket with every part a printed ticket draws. */
export const ADMISSION: PaperContent = {
  brand: 'Harbour Lights Festival',
  kind: 'admission',
  ink: 'colour',
  colors: { bg: '#5e0636', fg: '#ffffff', label: '#f6c5d6' },
  logo: true,
  title: 'Harbour Lights: Night Two',
  kicker: 'Event ticket',
  noun: 'ticket',
  once: true,
  start: '2027-02-13T19:30:00+13:00',
  doors: '2027-02-13T18:30:00+13:00',
  end: '2027-02-13T22:30:00+13:00',
  zone: 'Pacific/Auckland',
  venue: 'Pier 9 Amphitheatre',
  address: '9 Wharf Road, Wellington 6011',
  room: 'Main lawn',
  holder: 'Maya Okafor',
  type: 'General admission',
  seat: { section: 'B', row: '4', seat: '12' },
  facts: [
    { label: 'Section', text: 'B' },
    { label: 'Row', text: '4' },
    { label: 'Seat', text: '12' },
  ],
  bring: ['This page or your phone ticket', 'Photo ID in the name Maya Okafor'],
  help: ['hello@harbourlights.nz', '+64 4 555 0123'],
  terms: 'No re-entry. Ticket is non-transferable.',
  extras: [],
};

const PERMIT: PaperContent = {
  ...ADMISSION,
  kind: 'permit',
  kicker: 'Parking permit',
  type: 'Monthly',
  validUntil: '2027-12-31T23:59:00+00:00',
  zone: 'UTC',
  hero: { zone: 'C', plate: 'AB12 CDE' },
  facts: [{ label: 'Bay', text: '14' }],
};
const COUPON: PaperContent = {
  ...ADMISSION,
  kind: 'coupon',
  kicker: 'Coupon',
  noun: 'pass',
  once: false,
  validUntil: '2027-01-31T23:59:00+00:00',
  zone: 'UTC',
  hero: { offer: '20% off', offerNote: 'Your next order of $30 or more' },
};
const MEMBERSHIP: PaperContent = {
  ...ADMISSION,
  kind: 'membership',
  kicker: 'Membership',
  noun: 'pass',
  once: false,
  type: 'All-Inclusive',
  validUntil: '2027-12-31T23:59:00+00:00',
};

const CONTENT: Record<PaperKind, PaperContent> = {
  admission: ADMISSION,
  permit: PERMIT,
  coupon: COUPON,
  membership: MEMBERSHIP,
  pickup: { ...ADMISSION, kind: 'pickup', kicker: 'Order pickup', items: ['Roast chicken'] },
};

/** A ready-to-draw sheet of a kind and size; `paper` and `content` override the defaults. */
export function sheet(
  kind: PaperKind,
  size: PaperSize,
  over: {
    paper?: object;
    content?: Partial<PaperContent>;
    mode?: 'live' | 'test';
    mark?: PrintSheet['mark'];
    images?: PrintSheet['images'];
  } = {},
): PrintSheet {
  const barcode = kind === 'coupon' ? 'code128' : 'qr';
  const design = resolvePaper({ schema: 1, size, barcode, ...over.paper });
  return {
    design,
    content: { ...CONTENT[kind], ...over.content },
    code: SAMPLE_CODE,
    mark: over.mark ?? 'full',
    issued: { generation: 2, at: '2026-11-19T01:02:00Z' },
    ...(over.mode ? { mode: over.mode } : {}),
    ...(over.images ? { images: over.images } : {}),
  };
}
