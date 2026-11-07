import type { PassJson } from '../../passkit/types.ts';

const base = (serialNumber: string, description: string): PassJson => ({
  formatVersion: 1,
  passTypeIdentifier: 'pass.visual.example',
  teamIdentifier: 'TEAM123456',
  serialNumber,
  organizationName: 'Northwind Live',
  description,
  logoText: 'Northwind',
  backgroundColor: 'rgb(15, 68, 75)',
  foregroundColor: 'rgb(255, 255, 255)',
  labelColor: 'rgb(217, 244, 239)',
});

export const VISUAL_PASS_JSON: Record<string, PassJson> = {
  event: {
    ...base('EVENT-2048', 'Event ticket'),
    eventTicket: {
      headerFields: [{ key: 'gate', label: 'Gate', value: 'C' }],
      primaryFields: [{ key: 'event', label: 'Event', value: 'Northwind Gala' }],
      secondaryFields: [{ key: 'venue', label: 'Venue', value: 'Main Hall' }],
      auxiliaryFields: [{ key: 'seat', label: 'Seat', value: '104 · F · 12' }],
      backFields: [
        { key: 'entry', label: 'Entry', value: 'Use the east entrance at 6:30 PM.' },
        { key: 'help', label: 'Guest services', value: 'Visit the lobby desk for assistance.' },
      ],
    },
  },
  boarding: {
    ...base('BOARDING-2048', 'Boarding pass'),
    boardingPass: {
      transitType: 'PKTransitTypeAir',
      headerFields: [{ key: 'gate', label: 'Gate', value: 'A12' }],
      primaryFields: [
        { key: 'from', label: 'San Francisco', value: 'SFO' },
        { key: 'to', label: 'Tokyo', value: 'HND' },
      ],
      secondaryFields: [{ key: 'passenger', label: 'Passenger', value: 'Ada Lovelace' }],
      auxiliaryFields: [{ key: 'seat', label: 'Seat', value: '23A' }],
      backFields: [
        { key: 'boarding', label: 'Boarding', value: 'Group 2 · 6:20 PM' },
        { key: 'help', label: 'Support', value: 'Ask at the airline desk.' },
      ],
    },
  },
  identity: {
    ...base('IDENTITY-771', 'Identity'),
    generic: {
      primaryFields: [{ key: 'name', label: 'Name', value: 'Alexandria Morgan' }],
      secondaryFields: [{ key: 'organization', label: 'Organization', value: 'Northwind Arts' }],
      backFields: [
        { key: 'member', label: 'Member ID', value: 'NW-2048-771' },
        { key: 'issued', label: 'Issued by', value: 'Northwind Arts Council' },
      ],
    },
  },
  membership: {
    ...base('MEMBER-309', 'Membership'),
    storeCard: {
      headerFields: [{ key: 'level', label: 'Level', value: 'Founders' }],
      primaryFields: [{ key: 'plan', label: 'Membership', value: 'Annual' }],
      secondaryFields: [{ key: 'member', label: 'Member ID', value: 'NW-309' }],
      auxiliaryFields: [{ key: 'expires', label: 'Expires', value: 'Mar 2027' }],
      backFields: [
        { key: 'benefits', label: 'Benefits', value: 'Entry to member events and workshops.' },
        { key: 'renewal', label: 'Renewal', value: 'Renew before Mar 2027.' },
      ],
    },
  },
  loyalty: {
    ...base('LOYALTY-042', 'Loyalty card'),
    storeCard: {
      headerFields: [{ key: 'stamps', label: 'Stamps', value: '9 / 10' }],
      primaryFields: [{ key: 'reward', label: 'Reward', value: 'Free coffee' }],
      secondaryFields: [{ key: 'cafe', label: 'Cafe', value: 'Northwind Cafe' }],
      backFields: [
        { key: 'reward', label: 'Reward rules', value: 'One free coffee after ten stamps.' },
        { key: 'location', label: 'Cafe', value: 'Northwind Cafe · Main Hall' },
      ],
    },
  },
  wallet: {
    ...base('WALLET-3050', 'Stored value'),
    storeCard: {
      headerFields: [{ key: 'balance', label: 'Balance', value: '$30.50' }],
      primaryFields: [{ key: 'wallet', label: 'Wallet', value: 'Campus credit' }],
      secondaryFields: [{ key: 'member', label: 'Member ID', value: 'NW-042' }],
      backFields: [
        {
          key: 'transactions',
          label: 'Recent activity',
          value: 'Ask staff for transaction history.',
        },
        { key: 'support', label: 'Support', value: 'Visit the campus wallet desk.' },
      ],
    },
  },
  coupon: {
    ...base('COUPON-20', 'Coupon'),
    coupon: {
      headerFields: [{ key: 'offer', label: 'Offer', value: 'Spring' }],
      primaryFields: [{ key: 'discount', label: 'Discount', value: '20% off' }],
      secondaryFields: [{ key: 'code', label: 'Code', value: 'NORTHWIND20' }],
      backFields: [
        { key: 'terms', label: 'Terms', value: 'Valid weekdays. One redemption per visit.' },
        { key: 'support', label: 'Support', value: 'Ask at Northwind Cafe.' },
      ],
    },
  },
  generic: {
    ...base('GENERIC-001', 'Generic pass'),
    generic: {
      headerFields: [{ key: 'tier', label: 'Tier', value: 'Community' }],
      primaryFields: [{ key: 'name', label: 'Name', value: 'Alexandria-Montgomery Waweru' }],
      secondaryFields: [{ key: 'access', label: 'Access', value: 'East entrance' }],
      backFields: [
        { key: 'note', label: 'Note', value: 'Ask a supervisor if details differ.' },
        { key: 'support', label: 'Support', value: 'Visit the Northwind welcome desk.' },
      ],
    },
  },
};
