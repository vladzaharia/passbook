import { fullName, makePerson } from '../people.ts';
import { DAY, isoDate } from '../world.ts';
import { D, type DatasetDef, N, PERSON_FIELDS, personFields, S } from './types.ts';

const REWARDS: Record<string, readonly string[]> = {
  'en-US': ['Free coffee', 'Free pastry', '10% off', 'Free upgrade'],
  'en-GB': ['Free coffee', 'Free pastry', '10% off', 'Free upgrade'],
  'de-DE': ['Gratis Kaffee', 'Gratis Gebäck', '10 % Rabatt', 'Gratis Upgrade'],
  'fr-FR': ['Café offert', 'Pâtisserie offerte', '10 % de remise', 'Surclassement offert'],
  'es-ES': ['Café gratis', 'Pastel gratis', '10 % de descuento', 'Mejora gratis'],
};

/** 16 digits starting 99 (no card network issues it), the last one a Luhn check digit. */
export function luhnCard(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

export const loyaltyCards: DatasetDef = {
  prefix: 'l-',
  pad: 4,
  pageSize: 50,
  fields: {
    ...PERSON_FIELDS,
    holder: S,
    cardNumber: S,
    tier: S,
    balance: N,
    currency: S,
    points: N,
    stamps: N,
    reward: S,
    memberSince: D,
  },
  bad: ['holder', 'cardNumber'],
  build(x, index, r) {
    const p = makePerson(x, r, index);
    return {
      holderEmail: p.email,
      record: {
        ...personFields(p),
        holder: fullName(p),
        cardNumber: luhnCard(`99${r.pattern('#############')}`),
        tier: r.chance(25) ? 'Gold' : 'Standard',
        balance: r.range(0, 20000) / 100,
        currency: x.zone.currency,
        points: r.range(0, 3000),
        stamps: r.range(0, 9),
        reward: r.pick(REWARDS[x.c.locale] ?? REWARDS['en-US'] ?? []),
        memberSince: isoDate(x.t0 - r.range(30, 1800) * DAY),
      },
    };
  },
  change(_x, _i, record, r) {
    record.points = Number(record.points) + r.range(5, 200);
    record.balance = Math.max(
      0,
      Math.round((Number(record.balance) + r.range(-2000, 3000) / 100) * 100) / 100,
    );
    record.stamps = r.range(0, 9);
    if (Number(record.points) > 2500) record.tier = 'Gold';
  },
};
