import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.messageRules.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Day-before reminder',
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000b1',
  ],
  anchor: {
    kind: 'input',
    input: 'startsAt',
  },
  offset: {
    amount: 1,
    unit: 'day',
    when: 'before',
  },
  timeZone: 'Europe/Berlin',
  message: 'Tomorrow at 7 PM.',
});
console.log(result);
