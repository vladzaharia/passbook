import type {
  ApnsResult,
  ApnsTarget,
  ApnsTransport,
} from '../../src/worker/modules/delivery/apns.ts';
import type { Mailer, MailMessage } from '../../src/worker/modules/delivery/mailer.ts';

/** Rate-limit binding that counts by key and refuses past `limit` calls per key. */
export function fakeRateLimiter(options: { limit: number }) {
  const counts = new Map<string, number>();
  return {
    counts,
    async limit({ key }: { key: string }) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= options.limit };
    },
  } as unknown as RateLimit & { counts: Map<string, number> };
}

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
