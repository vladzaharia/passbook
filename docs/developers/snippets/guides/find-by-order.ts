import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const page = await pb.passes.list({ externalId: 'order-8841' });

console.log(page.items[0]?.id ?? 'no pass for this order');
