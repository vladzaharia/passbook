import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.messageRules.countDue({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Example',
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000b1',
  ],
  anchor: {
    kind: 'input',
    input: 'Example',
  },
  offset: {
    amount: 0,
    unit: 'day',
    when: 'before',
  },
  timeZone: 'Europe/Berlin',
  message: 'Example',
});
console.log(result);
