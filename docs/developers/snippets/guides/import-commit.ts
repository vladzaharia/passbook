import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Held mail waits out the undo window. `email: true` sends at once; the default sends nothing.
const run = await pb.passImports.commit('0193a1b2-7c00-7000-8000-0000000000e1', {
  skipInvalid: false,
  email: { send: 'held', holdMs: 300_000 },
});
console.log(run.state);
