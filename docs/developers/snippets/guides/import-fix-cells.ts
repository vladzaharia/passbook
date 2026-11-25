import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The import you just made is ready. In your code, keep the id from the create call.
const { items } = await pb.passImports.list();
const draft = await pb.passImports.retrieve(items.find((i) => i.state === 'ready')?.id ?? '');
if (!draft.plan) throw new Error('Map the columns first.');

// Row 3 is spreadsheet row 3: the header is row 1. The key is the column pointer.
const fixed = await pb.passImports.check(draft.id, {
  plan: { ...draft.plan, overrides: { '3': { '/Starts': '2030-06-01T19:00:00-07:00' } } },
});
console.log(fixed.counts);
