import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const key = await pb.apiKeys.retrieveCurrent();

console.log(key.mode, key.scopes);
