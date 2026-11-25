import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A sandbox has one capture endpoint. The call that makes it returns the secret; later calls return null.
const { endpoint, secret } = await pb.webhookEndpoints.ensureCapture({});
console.log(endpoint.id, secret);
