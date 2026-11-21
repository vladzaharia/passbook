import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

let cursor: string | undefined;

for (let i = 0; i < 3; i++) {
  const page = await pb.events.list({ after: cursor, limit: 100 });
  for (const event of page.items) console.log(event.type, event.id);
  // Keep the cursor, even when the page is empty: the next call starts there.
  cursor = page.nextCursor ?? cursor;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
