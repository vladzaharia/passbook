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

/** Cloudflare Email Sending binding. Sender is EMAIL_FROM (one onboarded address). */
export function createEmailBindingMailer(env: AppEnv): Mailer {
  return {
    async send(message) {
      const result = await env.EMAIL.send({
        from: { name: message.fromName ?? 'Wallet', email: env.EMAIL_FROM },
        to: message.to,
        subject: message.subject,
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
