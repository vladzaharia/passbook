import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.bulkUpdateChannels({
  action: 'on',
  channels: [
    'mobile',
  ],
  ids: [
    '0193a1b2-7c00-7000-8000-0000000000c1',
  ],
  notify: false,
  replaceCodes: false,
  dryRun: false,
});
console.log(result);
