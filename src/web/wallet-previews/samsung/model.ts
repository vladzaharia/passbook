import { formatDateTime } from '../../lib/format.ts';

/** What a Samsung card draws, read off the compiled card attributes. */
export interface SamsungModel {
  kind: string;
  type: string;
  state: string;
  bg: string | undefined;
  fg: 'light' | 'dark';
  logo: string | undefined;
  /** The card's background art (loyalty) or the banner (ticket, coupon). */
  image: string | undefined;
  title: string;
  provider: string;
  /** Loyalty: points and balance under the title. */
  amounts: { label: string; value: string }[];
  /** Ticket, coupon: the dates and numbers on the stub. */
  facts: { label: string; value: string }[];
  barcode: { bcid: string; message: string } | undefined;
  notice: string | undefined;
  contacts: { label: string; value: string }[];
  app: { name: string; logo: string | undefined } | undefined;
  places: string[];
}

type Attrs = Record<string, string>;
const KINDS: Record<string, string> = {
  loyalty: 'Loyalty card',
  ticket: 'Ticket',
  coupon: 'Coupon',
};
const BARCODES: Record<string, string> = {
  QRCODE: 'qrcode',
  PDF417: 'pdf417',
  AZTEC: 'azteccode',
  CODE128: 'code128',
  CODE39: 'code39',
  EAN13: 'ean13',
  ITF: 'interleaved2of5',
  CODABAR: 'rationalizedCodabar',
};

const when = (v: string | undefined): string | undefined => {
  const ms = Number(v);
  return v && Number.isFinite(ms) && ms > 0 ? formatDateTime(ms) : undefined;
};
const fact = (label: string, value: string | undefined) => (value ? [{ label, value }] : []);

function places(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as { name?: string }[];
    return list.flatMap((p) => (p.name ? [p.name] : []));
  } catch {
    // The compiler wrote it; an unreadable list is simply not drawn.
    return [];
  }
}

export function samsungModel(data: {
  type: string;
  subType?: string;
  state?: string;
  attributes: Attrs;
}): SamsungModel {
  const a = data.attributes;
  const ticket = data.type === 'ticket';
  const coupon = data.type === 'coupon';
  const code = a['barcode.value'];
  const format = BARCODES[a['barcode.ptFormat'] ?? ''] ?? BARCODES[a['barcode.serialType'] ?? ''];
  return {
    kind: KINDS[data.type] ?? data.type,
    type: data.type,
    state: data.state ?? 'ACTIVE',
    bg: a.bgColor,
    fg: a.fontColor?.toLowerCase() === '#000000' ? 'dark' : 'light',
    logo: a.logoImage,
    image: a.mainImg ?? a.bgImage,
    title: a.title ?? '',
    provider: a.providerName ?? '',
    amounts: [...fact('Points', a.amount), ...fact('Balance', a.balance)],
    facts: [
      ...(ticket ? fact('Starts', when(a.startDate)) : fact('Valid from', when(a.startDate))),
      ...(ticket ? fact('Ends', when(a.endDate)) : fact('Valid until', when(a.endDate))),
      ...(coupon ? fact('Expires', when(a.expiry)) : []),
      ...(ticket ? fact('Reservation', a.reservationNumber) : []),
    ],
    barcode: code && format ? { bcid: format, message: code } : undefined,
    notice: a.noticeDesc,
    contacts: [
      ...fact('Call', a['csInfo.call']),
      ...fact('Email', a['csInfo.email']),
      ...fact('Website', a['csInfo.webSite']),
    ],
    app: a.appLinkName ? { name: a.appLinkName, logo: a.appLinkLogo } : undefined,
    places: places(a.locations),
  };
}
