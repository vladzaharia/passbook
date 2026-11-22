import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.messageRules.update('0193a1b2-7c00-7000-8000-0000000000e1', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Ada Example',
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000a2',
  ],
  match: [
    {
      input: 'example',
      values: [
        'example',
      ],
    },
  ],
  anchor: {
    kind: 'input',
    input: 'example',
  },
  offset: {
    amount: 1,
    unit: 'day',
    when: 'before',
  },
  yearly: false,
  timeZone: 'example',
  message: 'example',
  version: 1,
});
console.log(result);
