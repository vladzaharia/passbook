import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const id = '0193a1b2-7c00-7000-8000-0000000000c1';
const current = await pb.passes.retrieve(id);

// If-Match is the version you read: a pass that changed since is refused, not overwritten.
// notify pushes the change to phones that have the pass.
const pass = await pb.passes.update(
  id,
  { input: { attendee: 'Ada Lovelace' }, notify: true },
  { headers: { 'If-Match': String(current.version) } },
);

console.log(pass.version);
