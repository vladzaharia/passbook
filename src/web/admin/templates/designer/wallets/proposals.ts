/**
 * Key-name suggestions for roles (D6). A pure UI hint: a guess never becomes a role on its own,
 * the author presses Use or Accept n. Never a field another role already reads, at most one
 * suggestion per role, deterministic over the same view.
 */
import type { WalletRoleSource } from '@/passkit/template/wallets/schema.ts';
import type { ViewField, WalletPassView, WalletRole } from '@/passkit/wallets/types.ts';

export interface Proposal {
  role: WalletRole;
  source: WalletRoleSource;
  /** The field's label, or `Organization name` for a title that would show twice. */
  label: string;
  /** What the role would show. */
  text: string;
}

/** Key or label with every non-letter and digit dropped, lower case. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const VOCABULARY: Partial<Record<WalletRole, readonly string[]>> = {
  tier: ['tier', 'level', 'status', 'membertier', 'membershiplevel'],
  points: ['points', 'point', 'pointsbalance', 'rewardpoints'],
  memberId: [
    'member',
    'memberid',
    'membernumber',
    'card',
    'cardnumber',
    'account',
    'accountnumber',
  ],
  memberName: ['name', 'holder', 'membername', 'cardholder', 'fullname'],
  ticketHolder: ['name', 'holder', 'ticketholder', 'attendee'],
  seat: ['seat', 'seatnumber'],
  row: ['row'],
  section: ['section', 'block'],
  gate: ['gate', 'entrance'],
  venueName: ['venue', 'venuename', 'location'],
  finePrint: ['terms', 'fine', 'fineprint', 'termsandconditions', 'conditions'],
  giftCardPin: ['pin', 'cardpin'],
  confirmationCode: [
    'confirmation',
    'confirmationcode',
    'booking',
    'bookingref',
    'ref',
    'reference',
  ],
};

/** Roles a style asks the name of: the holder of a ticket, the member of a card. */
const SKIPPED: Partial<Record<string, readonly WalletRole[]>> = {
  eventTicket: ['memberName'],
  storeCard: ['ticketHolder'],
  generic: ['ticketHolder'],
  coupon: ['ticketHolder'],
};

const fieldUsed = (view: WalletPassView, taken: ReadonlySet<string>, f: ViewField): boolean =>
  taken.has(f.path) || Object.values(view.roles).some((r) => r?.fields.includes(f.path));

const fieldText = (f: ViewField): string => f.text;

/**
 * Suggestions for roles the pass does not resolve (or a title that repeats another role's field).
 * `authored` is the `wallets.roles` block, so a role the author already set is left alone.
 */
export function proposeRoles(
  view: WalletPassView,
  authored: Partial<Record<WalletRole, unknown>> | undefined,
  duplicates: ReadonlySet<WalletRole> = new Set(),
): Proposal[] {
  const out: Proposal[] = [];
  const taken = new Set<string>();
  const skipped = SKIPPED[view.style] ?? [];
  for (const role of Object.keys(VOCABULARY) as WalletRole[]) {
    if (authored?.[role] !== undefined || view.roles[role] || skipped.includes(role)) continue;
    const words = VOCABULARY[role] ?? [];
    const hit = view.fields.find(
      (f) =>
        f.text.trim() !== '' &&
        !fieldUsed(view, taken, f) &&
        (words.includes(squash(f.key)) || (f.label ? words.includes(squash(f.label)) : false)),
    );
    if (!hit) continue;
    taken.add(hit.path);
    out.push({
      role,
      source: { field: hit.key },
      label: hit.label ?? hit.key,
      text: fieldText(hit),
    });
  }
  if (duplicates.has('title') && authored?.title === undefined && view.org.trim())
    out.push({ role: 'title', source: false, label: 'Organization name', text: view.org.trim() });
  return out;
}
