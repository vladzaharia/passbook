import { PassBook } from '@passbook/sdk';

// The reviewer's own key or session: you cannot approve your own version.
const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const templateId = '0193a1b2-7c00-7000-8000-0000000000b1';

// The inbox holds every version waiting on you, newest request first.
const inbox = await pb.templates.reviews.list();
const template = await pb.templates.retrieve(templateId);
const version =
  inbox.items.find((item) => item.templateId === templateId)?.version ??
  template.versions[0]?.version ??
  '';

// release: true also releases it when you may publish.
const done = await pb.templates.reviews.approve(templateId, { version, release: true });

console.log(done.approved);
