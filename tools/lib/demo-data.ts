// Demo dataset for tools/seed-demo.ts: who holds which pass, in which org and state.
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

const PEOPLE = [
  'Maya Chen',
  'Jonas Weber',
  'Priya Raman',
  'Diego Alvarez',
  'Hana Sato',
  'Omar Haddad',
  'Lena Novak',
  'Samuel Okafor',
  'Ines Duarte',
  'Theo Laurent',
  'Aisha Bello',
  'Marcus Lind',
  'Yuki Tanaka',
  'Clara Rossi',
  'Felix Brandt',
  'Nora Kim',
  'Rafael Costa',
  'Zoe Martin',
  'Ivan Petrov',
  'Leila Farah',
  'Ethan Brooks',
  'Sofia Moreau',
  'Kenji Mori',
  'Amara Nwosu',
  'Lucas Silva',
  'Elif Demir',
  'Noah Fischer',
  'Mila Horvat',
  'Arjun Mehta',
  'Grace Liu',
  'Tomas Ortega',
  'Esme Clarke',
  'Hugo Berg',
  'Laila Aziz',
  'Ben Carter',
  'Maximilian Alexander Featherstonehaugh-Worthington',
];
// Portal users sign in by magic link below; their passes end up owned.
export const PORTAL = ['Maya Chen', 'Jonas Weber', 'Priya Raman', 'Theo Laurent'];
export const emailOf = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim()
    .split(' ')
    .join('.')}@example.com`;

export type Plan = {
  template: string;
  org: string;
  input: Record<string, unknown>;
  holder?: string;
  void?: boolean;
  image?: string;
};
export function demoPlans(ids: {
  henrys: string;
  northwind: string;
  harbor: string;
  member: string;
}): Plan[] {
  const { henrys, northwind, harbor, member } = ids;
  const plans: Plan[] = [];
  PEOPLE.forEach((name, i) => {
    const n = String(i + 1).padStart(3, '0');
    // Every third pass has no holder. The rest wait for a holder, or end up owned by a portal user.
    const holder = PORTAL.includes(name) || i % 3 !== 2 ? emailOf(name) : undefined;
    const expiring = i % 9 === 4 ? iso(2 + (i % 4)) : undefined;
    const voided = i % 8 === 6;
    if (i < 14) {
      plans.push({
        template: i % 2 ? 'baked:henrys-copper' : 'baked:henrys-blue',
        org: henrys,
        input: {
          memberName: name,
          memberId: `HG-${n}`,
          membership: ['All-Inclusive Wellness', 'Fitness', 'Family', 'Student'][i % 4],
          homeClub: i % 3 ? 'capitol-hill' : 'queen-anne',
          access: i % 4 ? 'home' : 'all',
          status: voided ? 'Cancelled' : i === 10 ? 'Suspended' : 'Active',
          message: 'Welcome to Henry’s.',
          ...(expiring ? { expirationDate: expiring } : {}),
        },
        holder,
        void: voided,
      });
    } else if (i < 22) {
      const store = i % 2 === 0;
      plans.push({
        template: store ? 'baked:starter-store-card' : member,
        org: northwind,
        input: store
          ? {
              holder: name,
              cardNumber: `NW-${n}`,
              tier: i % 4 ? 'Standard' : 'Gold',
              balance: i * 7.5,
              currency: 'USD',
            }
          : {
              holder: name,
              memberId: `NW-M${n}`,
              tier: ['Standard', 'Plus', 'Pro'][i % 3],
              points: i * 115,
              since: iso(-400 + i * 9),
              ...(expiring ? { expirationDate: expiring } : {}),
            },
        holder,
        void: voided,
        ...(store ? {} : { image: 'thumbnail@2x.png' }),
      });
    } else if (i < 32) {
      plans.push({
        template: 'baked:starter-event-ticket',
        org: harbor,
        input: {
          eventName: 'Harbor Lights 2026',
          venueName: 'Pier 62',
          venueRegion: 'Seattle, WA',
          venueTimeZone: 'America/Los_Angeles',
          startsAt: iso(14 + (i % 3)),
          endsAt: iso(14.25 + (i % 3)),
          attendee: name,
          admission: i % 4 ? 'General admission' : 'VIP',
          seat: `Row ${String.fromCharCode(65 + (i % 6))}, seat ${i}`,
          ticketId: `HL-${n}`,
        },
        holder,
        void: voided,
        ...(i % 5 === 0 ? { image: 'strip@2x.png' } : {}),
      });
    } else {
      const coupon = i % 2 === 0;
      plans.push({
        template: coupon ? 'baked:starter-coupon' : 'baked:starter-generic',
        org: coupon ? northwind : harbor,
        input: coupon
          ? {
              offer: '15% off gear',
              code: `GEAR-${n}`,
              validFor: 'One purchase',
              expirationDate: iso(3 + i),
              timeZone: 'America/Los_Angeles',
            }
          : { holder: name, memberId: `CREW-${n}`, tier: 'Plus', points: 40 },
        holder,
        void: voided,
      });
    }
  });

  // A portal user with passes from all three orgs.
  plans.push(
    {
      template: member,
      org: northwind,
      input: { holder: 'Maya Chen', memberId: 'NW-M900', tier: 'Pro', points: 2410 },
      holder: emailOf('Maya Chen'),
      image: 'thumbnail@2x.png',
    },
    {
      template: 'baked:starter-event-ticket',
      org: harbor,
      input: {
        eventName: 'Harbor Lights 2026',
        venueName: 'Pier 62',
        venueRegion: 'Seattle, WA',
        venueTimeZone: 'America/Los_Angeles',
        startsAt: iso(15),
        endsAt: iso(15.25),
        attendee: 'Maya Chen',
        admission: 'VIP',
        seat: 'Row A, seat 4',
        ticketId: 'HL-900',
      },
      holder: emailOf('Maya Chen'),
    },
    {
      template: 'baked:starter-coupon',
      org: northwind,
      input: {
        offer: 'Free day pass',
        code: 'GEAR-900',
        validFor: 'One visit',
        expirationDate: iso(4),
      },
      holder: emailOf('Jonas Weber'),
    },
  );
  return plans;
}
