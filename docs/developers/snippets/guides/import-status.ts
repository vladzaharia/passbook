import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The newest import is the one you just made. In your code, keep the id from the create call.
const { items } = await pb.passImports.list({ limit: 1 });
const imp = await pb.passImports.retrieve(items[0]?.id ?? '');

// Read again until state is done. progress counts what the commit has done so far.
console.log(imp.state, imp.progress);
