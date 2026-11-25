import type { Rng } from './prng.ts';
import type { Ctx } from './world.ts';
import { DAY } from './world.ts';

const AVATAR = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const;

/**
 * Official fictional ranges: NANP 212 555-01xx, Ofcom drama 07700 900xxx, Arcep 06 39 98 xx xx, and Berlin
 * 030 23125 xxx. Spain publishes none, so its pattern starts 000, which no Spanish number can.
 */
const PHONE: Record<string, string> = {
  'en-US': '(212) 555-01##',
  'en-GB': '07700 900###',
  'de-DE': '+49 30 23125###',
  'fr-FR': '+33 6 39 98 ## ##',
  'es-ES': '+34 000 ### ###',
};

/** ASCII, lower case, letters and digits only: safe in an email local part. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

function street(x: Ctx, r: Rng): string {
  const { words, c } = x;
  const last = r.pick(words.last);
  const suffix = r.pick(words.street);
  const n = r.range(1, c.locale === 'en-US' ? 9999 : 120);
  switch (c.locale) {
    case 'en-US':
    case 'en-GB':
      return `${n} ${last} ${suffix}`;
    case 'de-DE':
      return `${last}${suffix} ${n}`;
    case 'fr-FR':
      return `${n} ${r.pick(['rue', 'avenue', 'boulevard', 'place'])} ${suffix}`;
    default:
      return `${r.pick(['Calle', 'Avenida', 'Plaza', 'Paseo'])} ${last} ${suffix}, ${n}`;
  }
}

export interface Person {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthday: string;
  address: { street: string; city: string; region: string; postcode: string };
  initials: string;
  avatarColor: string;
}

/** `index` keeps emails unique within a dataset. Photos are initials only: no URLs, no image data. */
export function makePerson(x: Ctx, r: Rng, index: number): Person {
  const { words, c } = x;
  const firstName = r.pick(words.first);
  const lastName = r.pick(words.last);
  const age = r.range(18, 80);
  const birth = x.t0 - age * 365 * DAY - r.int(365) * DAY;
  return {
    firstName,
    lastName,
    email: `${fold(firstName)}.${fold(lastName)}${index}@${c.holderDomain}`,
    phone: r.pattern(PHONE[c.locale] ?? PHONE['en-US'] ?? ''),
    birthday: new Date(birth).toISOString().slice(0, 10),
    address: {
      street: street(x, r),
      city: r.pick(words.city),
      region: r.pick(words.region),
      postcode: r.pattern(r.pick(words.postcode)),
    },
    initials: `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase(),
    avatarColor: AVATAR[(firstName.length + lastName.length + index) % AVATAR.length] ?? 'blue',
  };
}

export const fullName = (p: Person) => `${p.firstName} ${p.lastName}`;
