// Header signals: a header names a target exactly, or is a known synonym, or is one edit away.

/** Lowercase letters and digits only: `Member ID`, `member_id` and `memberId` all read `memberid`. */
export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `Member #`, `Member no.` and `Member number` read as `memberid`. */
export function idForm(header: string): string {
  const spaced = header
    .trim()
    .toLowerCase()
    .replace(/\s*#\s*$/, ' id');
  return norm(spaced.replace(/[\s_-](no\.?|num|number|code)$/, ' id'));
}

/**
 * Names that mean the same thing. A target is in a group when its key or label is; a header in the
 * same group is Similar. Only names an export really uses: a false match costs more than a miss.
 */
const GROUPS: readonly (readonly string[])[] = [
  ['email', 'emailaddress', 'holderemail', 'mail', 'contactemail', 'customeremail', 'memberemail'],
  ['name', 'fullname', 'holdername', 'membername', 'customername', 'guestname', 'attendeename'],
  ['firstname', 'givenname', 'forename', 'first'],
  ['lastname', 'surname', 'familyname', 'last'],
  ['externalid', 'id', 'reference', 'ref', 'externalref', 'externalreference'],
  [
    'validuntil',
    'paidthrough',
    'paiduntil',
    'expires',
    'expiry',
    'expiration',
    'expirationdate',
    'expirydate',
    'expiresat',
    'expireson',
    'enddate',
    'ends',
    'validthrough',
    'validto',
    'renews',
    'renewaldate',
  ],
  ['validfrom', 'startdate', 'starts', 'since', 'membersince', 'joined', 'joindate'],
  ['guests', 'guestpasses', 'guestsleft', 'guestcount'],
  ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'tel', 'telephone', 'cell'],
  ['status', 'membershipstatus', 'memberstatus'],
];

const groupOf = new Map<string, number>();
GROUPS.forEach((names, i) => {
  for (const n of names) groupOf.set(n, i);
});

/** At most one insert, delete or substitution, for names of 5 or more letters. */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export type NameSignal = 'exact' | 'similar' | null;

/** How a header names a target known by `names` (its key and label). */
export function nameSignal(header: string, names: readonly string[]): NameSignal {
  const h = norm(header);
  if (h === '') return null;
  const targets = names.map(norm).filter((n) => n !== '');
  if (targets.includes(h)) return 'exact';
  const id = idForm(header);
  if (id !== h && targets.some((t) => t.endsWith('id') && t === id)) return 'similar';
  const group = groupOf.get(h);
  if (group !== undefined && targets.some((t) => groupOf.get(t) === group)) return 'similar';
  if (targets.some((t) => oneEdit(h, t))) return 'similar';
  return null;
}

/** A target that holds a person's whole name, so a first and a last name column can join into it. */
export const isNameTarget = (names: readonly string[]): boolean =>
  names.some((n) => groupOf.get(norm(n)) === 1);
export const isFirstName = (header: string): boolean => groupOf.get(norm(header)) === 2;
export const isLastName = (header: string): boolean => groupOf.get(norm(header)) === 3;
