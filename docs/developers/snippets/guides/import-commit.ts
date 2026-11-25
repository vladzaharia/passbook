import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The import you just checked is ready. In your code, keep the id from the create call.
const { items } = await pb.passImports.list();

// Held mail waits out the undo window. `email: true` sends at once; the default sends nothing.
const run = await pb.passImports.commit(items.find((i) => i.state === 'ready')?.id ?? '', {
  skipInvalid: false,
  email: { send: 'held', holdMs: 300_000 },
});
console.log(run.state);
