import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The newest change run is the one you just started. In your code, keep the id from the create call.
const { items } = await pb.broadcasts.list({ kind: 'change', limit: 1 });
const run = await pb.broadcasts.retrieve(items[0]?.id ?? '');

// Read again until state leaves scheduled and sending.
console.log(run.state, run.counts);
