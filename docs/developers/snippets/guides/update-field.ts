import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// notify pushes the change to phones that have the pass.
const pass = await pb.passes.update('0193a1b2-7c00-7000-8000-0000000000c1', {
  input: { attendee: 'Ada Lovelace' },
  notify: true,
});

console.log(pass.version);
