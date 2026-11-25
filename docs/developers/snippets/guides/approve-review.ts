import { PassBook } from '@passbook/sdk';

// The reviewer's own key or session: you cannot approve your own version.
const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The inbox holds every version waiting on you, newest request first.
const inbox = await pb.templates.reviews.list();
const waiting = inbox.items[0];

if (waiting) {
  // release: true also releases it when you may publish.
  const done = await pb.templates.reviews.approve(waiting.templateId, {
    version: waiting.version,
    release: true,
  });
  console.log(done.approved);
} else console.log('Nothing waits on you.');
