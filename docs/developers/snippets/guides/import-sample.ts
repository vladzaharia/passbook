import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A header row of the template's field labels and one valid row.
const res = await pb.templates.downloadSample('0193a1b2-7c00-7000-8000-0000000000b1');
console.log(await res.text());
