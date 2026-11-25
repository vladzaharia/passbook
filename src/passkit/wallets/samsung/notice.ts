/**
 * `noticeDesc`: the one free-text slot of every Samsung type. It carries what has no native
 * attribute, as `Label: value` lines in Apple's front-to-back order (architecture 3.3 step 2).
 */
import { measure, sanitizeText, shorten } from '../text.ts';
import type { CapabilityId, ViewField, WalletRole } from '../types.ts';
import { WALLET_ROLES } from '../types.ts';
import { formatWhen } from '../when.ts';
import { block, isChosen, note, type Run } from './context.ts';
import { roleText } from './format.ts';
import { NOTICE_MIN_ROOM, SAMSUNG_LIMITS } from './limits.ts';

interface Line {
  text: string;
  /** Never cut, never dropped: the pass is blocked when these alone do not fit. */
  identity: boolean;
  capability: CapabilityId;
  path: string;
}

/** Labels for facts that have no field of their own. Roles not listed here are never written as text. */
const ROLE_LABELS: Partial<Record<WalletRole, string>> = {
  subtitle: 'Subtitle',
  eventName: 'Event',
  eventStart: 'Starts',
  eventEnd: 'Ends',
  doorsOpen: 'Doors open',
  venueName: 'Venue',
  venueAddress: 'Address',
  seat: 'Seat',
  row: 'Row',
  section: 'Section',
  gate: 'Gate',
  ticketHolder: 'Ticket holder',
  ticketNumber: 'Ticket number',
  confirmationCode: 'Confirmation',
  memberId: 'Member ID',
  memberName: 'Member',
  tier: 'Tier',
  points: 'Points',
  balance: 'Balance',
  giftCardNumber: 'Card number',
  giftCardPin: 'PIN',
  offerTitle: 'Offer',
  offerDetails: 'Details',
  finePrint: 'Fine print',
  validFrom: 'Valid from',
  validUntil: 'Valid until',
};
const IDENTITY_ROLES = new Set<WalletRole>([
  'memberId',
  'giftCardNumber',
  'giftCardPin',
  'ticketNumber',
  'confirmationCode',
]);

const labelled = (label: string | undefined, value: string): string =>
  label ? `${label}: ${value}` : value;

function fieldValue(field: ViewField, run: Run): string {
  let text = field.text;
  if ((field.dateStyle || field.timeStyle) && typeof field.value === 'string')
    text = formatWhen(field.value, field.dateStyle, field.timeStyle);
  else if (field.currencyCode && text) text = `${text} ${field.currencyCode}`;
  return sanitizeText(run.tr(text));
}

export interface NoticeInput {
  /** Apple field paths a native attribute already carries. */
  consumed: ReadonlySet<string>;
  /** Roles this type carries natively. */
  nativeRoles: ReadonlySet<WalletRole>;
  /** Links already shown elsewhere (the app link and the contacts). */
  shownUrls: ReadonlySet<string>;
  /** The serial text Samsung shows under the barcode. */
  serial?: string;
}

function roleLines(run: Run, input: NoticeInput): Line[] {
  const lines: Line[] = [];
  for (const role of WALLET_ROLES) {
    const value = run.view.roles[role];
    const label = ROLE_LABELS[role];
    if (!value || label === undefined || input.nativeRoles.has(role)) continue;
    const path = value.fields[0] ?? '';
    if (isChosen(run, `role.${role}`)) {
      note(run, `role.${role}`, path, 'omitted', 'Left out by the author.');
      continue;
    }
    note(run, `role.${role}`, path, 'text', `Written in the notice as "${label}".`);
    if (value.fields.length > 0) continue;
    let text = roleText(value);
    const unit = run.view.roles.pointsLabel;
    if (role === 'points' && unit?.kind === 'text') text = `${text} ${unit.text}`;
    text = sanitizeText(run.tr(text));
    if (!text || (role === 'memberId' && text === input.serial)) continue;
    lines.push({
      text: labelled(run.tr(label), text),
      identity: IDENTITY_ROLES.has(role),
      capability: `role.${role}`,
      path,
    });
  }
  return lines;
}

function fieldLines(run: Run, input: NoticeInput): Line[] {
  const identityPaths = new Set<string>();
  for (const role of IDENTITY_ROLES)
    for (const p of run.view.roles[role]?.fields ?? []) identityPaths.add(p);
  const lines: Line[] = [];
  for (const field of run.view.fields) {
    if (input.consumed.has(field.path)) continue;
    const capability: CapabilityId = `field.${field.group}`;
    const text = fieldValue(field, run);
    if (!text) continue;
    if (isChosen(run, capability, field.path)) {
      note(run, capability, field.path, 'omitted', 'Left out by the author.');
      continue;
    }
    lines.push({
      text: labelled(field.label ? sanitizeText(run.tr(field.label)) : undefined, text),
      identity: identityPaths.has(field.path),
      capability,
      path: field.path,
    });
  }
  return lines;
}

function linkLines(run: Run, input: NoticeInput): Line[] {
  const { featuredActions, urls } = run.view.links;
  const found: { path: string; url: string }[] = [
    ...featuredActions.flatMap((a) =>
      a.url ? [{ path: `featuredActions.${a.identifier}`, url: a.url }] : [],
    ),
    ...Object.entries(urls).map(([key, url]) => ({ path: `urls.${key}`, url })),
  ];
  const lines: Line[] = [];
  const seen = new Set(input.shownUrls);
  for (const { path, url } of found) {
    if (seen.has(url) || !/^(?:https:\/\/|tel:|mailto:)/iu.test(url)) continue;
    seen.add(url);
    if (isChosen(run, 'links.featured', path)) {
      note(run, 'links.featured', path, 'omitted', 'Left out by the author.');
      continue;
    }
    lines.push({ text: url, identity: false, capability: 'links.featured', path });
  }
  return lines;
}

/** A field's change text (`%@` is its value, `%%` a percent sign): Samsung has no notifying call, so the card carries it. */
function messageLines(run: Run): Line[] {
  const lines: Line[] = [];
  for (const field of run.view.fields) {
    if (typeof field.changeMessage !== 'string') continue;
    const value = fieldValue(field, run);
    const text = sanitizeText(
      run
        .tr(field.changeMessage)
        .replace(/%([@%])/gu, (_m, c: string) => (c === '@' ? value : '%')),
    );
    if (text)
      lines.push({ text, identity: false, capability: 'messaging.notify', path: field.path });
  }
  return lines;
}

/** Fits the lines in `noticeDesc`. Identity lines are kept whole; display lines yield in order. */
function assemble(run: Run, lines: Line[]): string {
  const max = SAMSUNG_LIMITS.noticeDesc.max;
  const size = (l: Line) => measure(l.text, 'bytes') + 1;
  const identityTotal = lines.filter((l) => l.identity).reduce((n, l) => n + size(l), -1);
  if (identityTotal > max) {
    block(
      run,
      'IDENTITY_TOO_LONG',
      `Identity values are longer than the Samsung notice (${max} bytes).`,
    );
    return '';
  }
  const kept: string[] = [];
  let used = -1;
  let full = false;
  for (const [i, line] of lines.entries()) {
    const reserved = lines
      .slice(i + 1)
      .filter((l) => l.identity)
      .reduce((n, l) => n + size(l), 0);
    const room = max - used - 1 - reserved;
    let text = line.text;
    if (!line.identity && (full || measure(text, 'bytes') > room)) {
      const cut =
        full || room < NOTICE_MIN_ROOM ? '' : shorten(text, { unit: 'bytes', max: room }).text;
      full = true;
      if (!cut) {
        note(run, line.capability, line.path, 'omitted', 'It does not fit in the Samsung notice.');
        continue;
      }
      text = cut;
      note(
        run,
        'text.length',
        line.path || line.capability,
        'difference',
        `Shortened to fit the ${max}-byte notice.`,
      );
    }
    note(run, line.capability, line.path, 'text', 'Written in the notice.');
    kept.push(text);
    used += measure(text, 'bytes') + 1;
  }
  return kept.join('\n');
}

/** A line that repeats an earlier one word for word (Apple's poster fields do) is written once. */
function dedupe(run: Run, lines: Line[]): Line[] {
  const first = new Map<string, Line>();
  const out: Line[] = [];
  for (const line of lines) {
    const seen = first.get(line.text);
    if (!seen) {
      first.set(line.text, line);
      out.push(line);
      continue;
    }
    seen.identity ||= line.identity;
    note(run, line.capability, line.path, 'text', 'Same text as an earlier line.');
  }
  return out;
}

/** The notice text, with an item for every line kept, shortened or dropped. */
export function buildNotice(run: Run, input: NoticeInput): string {
  const lines = [
    ...roleLines(run, input),
    ...fieldLines(run, input),
    ...linkLines(run, input),
    ...messageLines(run),
  ];
  return assemble(run, dedupe(run, lines));
}
