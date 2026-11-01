import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../platform/env.ts';
import { createEmailBindingMailer } from './mailer.ts';

describe('createEmailBindingMailer', () => {
  it('flattens line breaks and controls in subject and sender name', async () => {
    const sent: { subject: string; from: { name: string } }[] = [];
    const env = {
      EMAIL_FROM: 'passes@example.test',
      EMAIL: {
        send: async (m: (typeof sent)[number]) => {
          sent.push(m);
          return { messageId: 'm1' };
        },
      },
    } as unknown as AppEnv;
    await createEmailBindingMailer(env).send({
      to: 'a@example.test',
      subject: 'Your A\nB pass\r\nBcc: x@y.z\u2028\u202E',
      fromName: 'Acme\r\nBcc: x',
      html: '<p>x</p>',
      text: 'x',
    });
    expect(sent[0]?.subject).toBe('Your A B pass Bcc: x@y.z');
    expect(sent[0]?.from.name).toBe('Acme Bcc: x');
  });
});
