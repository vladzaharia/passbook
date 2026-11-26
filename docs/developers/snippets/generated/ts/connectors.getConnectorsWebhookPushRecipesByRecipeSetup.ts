import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connectors.recipeSetup.retrieve('shopify-orders');
console.log(result);
