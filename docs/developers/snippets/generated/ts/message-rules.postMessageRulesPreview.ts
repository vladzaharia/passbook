import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.messageRules.countDue({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Renewal reminder',
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000b1',
  ],
  anchor: {
    kind: 'input',
    input: 'validUntil',
  },
  offset: {
    amount: 7,
    unit: 'day',
    when: 'before',
  },
  yearly: false,
  sendAt: '09:00',
  timeZone: 'America/Los_Angeles',
  message: 'Your membership renews in 7 days.',
});
console.log(result);
