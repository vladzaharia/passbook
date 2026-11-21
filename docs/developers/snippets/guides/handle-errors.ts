import { ApiError, PassBook, ValidationError } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

try {
  await pb.passes.create({ templateId: '0193a1b2-7c00-7000-8000-0000000000b1', input: {} });
} catch (error) {
  if (error instanceof ValidationError) console.log(error.code, error.issues);
  else if (error instanceof ApiError) console.log(error.status, error.code, error.requestId);
  else throw error;
}
