import { ApiError, PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Version 0 never exists, so this stands for any version older than the pass.
try {
  await pb.passes.update(
    '0193a1b2-7c00-7000-8000-0000000000c1',
    { input: { attendee: 'Ada Lovelace' } },
    { headers: { 'If-Match': '0' } },
  );
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  // 412 VERSION_CONFLICT: read the pass again, apply your change, send the new version.
  console.log(error.status, error.code);
}
