import type {
  ApnsResult,
  ApnsTarget,
  ApnsTransport,
} from '../../src/worker/modules/delivery/apns.ts';
import type { Mailer, MailMessage } from '../../src/worker/modules/delivery/mailer.ts';

export interface FakeApns extends ApnsTransport {
  sent: { target: ApnsTarget; token: string }[];
  /** token -> result override. Default is 200. */
  results: Map<string, Partial<ApnsResult>>;
  available: boolean;
}

export function createFakeApns(): FakeApns {
  const fake: FakeApns = {
    sent: [],
    results: new Map(),
    available: true,
    isAvailable: () => fake.available,
    async send(target, tokens) {
      return tokens.map((token) => {
        fake.sent.push({ target, token });
        return { token, status: 200, ...fake.results.get(token) };
      });
    },
  };
  return fake;
}

export interface FakeMailer extends Mailer {
  sent: MailMessage[];
  fail: Error | null;
}

export function createFakeMailer(): FakeMailer {
  const fake: FakeMailer = {
    sent: [],
    fail: null,
    async send(message) {
      if (fake.fail) throw fake.fail;
      fake.sent.push(message);
      return { messageId: `fake-${fake.sent.length}` };
    },
  };
  return fake;
}
