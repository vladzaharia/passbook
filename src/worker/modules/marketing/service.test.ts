import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/env.ts';
import { createFakeMailer } from '../../../../test/helpers/fakes.ts';
import { createDetachedContext } from '../../platform/service-context.ts';
import { submitAccessRequest } from './service.ts';

const input = {
  name: 'Maya Lin',
  email: 'maya@studio.example',
  org: 'Studio <Lin>',
  purpose: 'Events and tickets',
  message: '<img src=x onerror=alert(1)>',
};

describe('submitAccessRequest', () => {
  it('sends to the configured inbox, replies to the sender and escapes the body', async () => {
    const ctx = createDetachedContext(
      await makeEnv({ ACCESS_REQUEST_EMAIL: 'Inbox@PassBook.example' }),
    );
    const mailer = createFakeMailer();
    await submitAccessRequest(ctx, input, mailer);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail?.to).toBe('inbox@passbook.example');
    expect(mail?.replyTo).toBe('maya@studio.example');
    expect(mail?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail?.html).not.toContain('<img src=x');
    expect(mail?.html).toContain('Studio &lt;Lin&gt;');
  });

  it('the honeypot sends nothing and resolves', async () => {
    const ctx = createDetachedContext(await makeEnv());
    const mailer = createFakeMailer();
    await expect(
      submitAccessRequest(ctx, { ...input, website: 'x' }, mailer),
    ).resolves.toBeUndefined();
    expect(mailer.sent).toHaveLength(0);
  });

  it('a mailer failure is a 503 ACCESS_MAIL_UNAVAILABLE', async () => {
    const ctx = createDetachedContext(await makeEnv());
    const mailer = createFakeMailer();
    mailer.fail = new Error('down');
    await expect(submitAccessRequest(ctx, input, mailer)).rejects.toMatchObject({
      status: 503,
      code: 'ACCESS_MAIL_UNAVAILABLE',
    });
  });
});
