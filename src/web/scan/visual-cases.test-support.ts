import type { ScanDisplay } from '../../shared/contracts/scan-display.ts';
import { display, panel } from './display/display.test-support.ts';
import { visualOutcome } from './visual-outcome.test-support.ts';

const column = (label: string, value: string) => ({ label, value });
const field = (id: string, label: string, value: string) => ({
  type: 'field' as const,
  id,
  label,
  value,
  icon: null,
  strong: false,
});
const identity = (
  holder: string,
  initials: string,
  meta: string,
  title: string | null,
  icon: ScanDisplay['header']['icon'],
) => ({
  identity: { holder, initials, photo: null },
  header: { icon, title, titleLines: 1 as const, meta, chips: [] },
});

const cases: { id: string; name: string; display: ScanDisplay; style: string }[] = [
  {
    id: 'event',
    name: 'Event ticket',
    style: 'eventTicket',
    display: display(
      [
        panel(
          [
            {
              type: 'big',
              id: 'seat',
              label: null,
              value: '104 · F · 12',
              unit: null,
              tone: 'teal',
            },
            field('admission', 'Ticket', 'General admission'),
            field('doors', 'Doors', '7:00 PM'),
            field('room', 'Room', 'Main hall'),
          ],
          { kind: 'ticket', title: 'Gala access', icon: 'ticket', tone: 'teal' },
        ),
      ],
      {
        ...identity('Priya N. Shah', 'PS', 'General admission', null, 'ticket'),
        header: {
          ...identity('Priya N. Shah', 'PS', 'General admission', null, 'ticket').header,
          chips: [{ id: 'vip', text: 'VIP', tone: 'gold', icon: 'crown' }],
        },
      },
    ),
  },
  {
    id: 'boarding',
    name: 'Boarding pass',
    style: 'boardingPass',
    display: display(
      [
        panel(
          [
            {
              type: 'columns',
              id: 'route',
              size: 'big',
              oneLine: true,
              items: [column('Origin', 'SFO'), column('Destination', 'HND')],
            },
            field('flight', 'Flight', 'NW 2048'),
            field('seat', 'Seat', '23A'),
            field('boarding', 'Boarding', '6:20 PM'),
          ],
          { kind: 'ticket', title: 'Flight details', icon: 'map-pin', tone: 'teal' },
        ),
      ],
      identity('Ada Lovelace', 'AL', 'Flight NW 2048', null, 'ticket'),
    ),
  },
  {
    id: 'identity',
    name: 'Identity',
    style: 'generic',
    display: display(
      [
        panel(
          [
            field('organization', 'Organization', 'Northwind Arts Council'),
            field('role', 'Role', 'Volunteer coordinator'),
            field('member', 'Member ID', 'NW-2048-771'),
          ],
          { kind: 'details', title: 'Identity details', icon: 'id-card', tone: 'violet' },
        ),
      ],
      identity('Alexandria Morgan', 'AM', 'Verified identity', 'Identity confirmed', 'id-card'),
    ),
  },
  {
    id: 'membership',
    name: 'Membership',
    style: 'storeCard',
    display: display(
      [
        panel(
          [
            {
              type: 'columns',
              id: 'dates',
              size: 'normal',
              oneLine: true,
              items: [column('Member since', 'Mar 2024'), column('Expires', 'Mar 2027')],
            },
            {
              type: 'columns',
              id: 'visits',
              size: 'normal',
              oneLine: true,
              items: [column('Last visit', '2 days ago'), column('This month', '9 visits')],
            },
          ],
          { kind: 'membership', title: 'Membership', icon: 'dumbbell', tone: 'violet' },
        ),
      ],
      identity('Morgan Ellis', 'ME', 'Founders plan', 'Welcome back', 'dumbbell'),
    ),
  },
  {
    id: 'loyalty',
    name: 'Loyalty',
    style: 'storeCard',
    display: display(
      [
        panel(
          [
            {
              type: 'progress',
              id: 'stamps',
              value: 9,
              goal: 10,
              before: 7,
              style: 'stamps',
              icon: 'coffee',
              rewards: 0,
              caption: '1 more for a free coffee',
            },
          ],
          { kind: 'loyalty', title: 'Coffee rewards', icon: 'coffee', tone: 'gold' },
        ),
      ],
      identity('Maya Lopez', 'ML', 'Gold member', null, 'coffee'),
    ),
  },
  {
    id: 'wallet',
    name: 'Wallet balance',
    style: 'storeCard',
    display: display(
      [
        panel(
          [
            {
              type: 'money',
              id: 'balance',
              label: 'Available credit',
              amount: 30.5,
              currency: 'USD',
              text: '$30.50',
              before: 42.5,
              change: -12,
              low: false,
              pending: [],
            },
            {
              type: 'history',
              id: 'transactions',
              items: [
                {
                  at: 1,
                  when: 'Today · 6:10 PM',
                  amount: '−$12.00',
                  delta: null,
                  where: 'Main desk',
                  label: 'Purchase',
                  elsewhere: false,
                },
                {
                  at: 2,
                  when: 'Yesterday',
                  amount: '+$25.00',
                  delta: null,
                  where: 'Top-up',
                  label: 'Credit added',
                  elsewhere: false,
                },
              ],
              empty: null,
            },
          ],
          { kind: 'balance', title: 'Stored value', icon: 'wallet', tone: 'teal' },
        ),
      ],
      identity('Alex Morgan', 'AM', 'Campus wallet', null, 'wallet'),
    ),
  },
  {
    id: 'coupon',
    name: 'Coupon',
    style: 'coupon',
    display: display(
      [
        panel(
          [
            { type: 'big', id: 'offer', label: null, value: '20% off', unit: null, tone: 'gold' },
            {
              type: 'columns',
              id: 'terms',
              size: 'normal',
              oneLine: true,
              items: [column('On', 'Any drink'), column('When', 'Weekdays')],
            },
            {
              type: 'columns',
              id: 'uses',
              size: 'normal',
              oneLine: true,
              items: [column('Uses left', '2'), column('Use by', 'Dec 31')],
            },
          ],
          { kind: 'offer', title: 'Offer', icon: 'percent', tone: 'gold' },
        ),
      ],
      identity('Sam Rivera', 'SR', 'Cafe rewards', null, 'percent'),
    ),
  },
  {
    id: 'generic',
    name: 'Generic long data',
    style: 'generic',
    display: display(
      [
        panel(
          [
            field('organization', 'Organization', 'Northwind Community Arts & Culture Association'),
            {
              type: 'columns',
              id: 'schedule',
              size: 'normal',
              oneLine: false,
              items: [column('Valid for', 'Saturday eve'), column('Area', 'Gallery wing')],
            },
            {
              type: 'note',
              id: 'staff-note',
              text: 'If the printed name differs, check with a supervisor.',
              tone: 'attention',
              icon: 'info',
            },
          ],
          { kind: 'details', title: 'Pass details', icon: 'card', tone: 'neutral' },
        ),
      ],
      identity('Alexandria-Montgomery Waweru', 'AW', 'Community access pass', null, 'card'),
    ),
  },
];

export const SCAN_VISUAL_CASES = cases.map(({ id, name, display: passDisplay, style }) => ({
  id,
  name,
  outcome: visualOutcome(id, name, style, passDisplay),
}));
