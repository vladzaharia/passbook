import type { AppEnv } from '../../platform/env.ts';

export interface MailAttachment {
  filename: string;
  type: string;
  content: Uint8Array;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Defaults to "Wallet <EMAIL_FROM>". */
  fromName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const HEADER_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;
/** Backstop for values stored before write-time validation: no value may break a header line. */
const oneLine = (value: string) => value.replace(HEADER_UNSAFE, ' ').replace(/ {2,}/g, ' ').trim();

/** Cloudflare Email Sending binding. Sender is EMAIL_FROM (one onboarded address). */
export function createEmailBindingMailer(env: AppEnv): Mailer {
  return {
    async send(message) {
      const result = await env.EMAIL.send({
        from: { name: oneLine(message.fromName ?? 'Wallet'), email: env.EMAIL_FROM },
        to: message.to,
        subject: oneLine(message.subject),
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((a) => ({
                disposition: 'attachment' as const,
                filename: a.filename,
                type: a.type,
                content: a.content,
              })),
            }
          : {}),
      });
      return { messageId: result.messageId };
    },
  };
}
