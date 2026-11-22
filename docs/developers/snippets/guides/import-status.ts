import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Read again until state is done. progress counts what the commit has done so far.
const imp = await pb.passImports.retrieve('0193a1b2-7c00-7000-8000-0000000000e1');
console.log(imp.state, imp.progress);
