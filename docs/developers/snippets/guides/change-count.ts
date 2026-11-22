import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// count: true adds the number of passes the filters match.
const page = await pb.passes.list({ templateId: '0193a1b2-7c00-7000-8000-0000000000b1', count: 'true', limit: 1 });
console.log(page.count);
