import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactString } from './log.ts';

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      ok: 'yes',
      code: 'NOT_FOUND',
      headers: { authorization: 'Bearer abc', cookie: 'x' },
      body: { email: 'a@b.co', personalization: { n: 1 }, nested: { sessionId: 's' } },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/Bearer abc|a@b\.co|"n":1/);
    expect(out.code).toBe('NOT_FOUND');
    expect(out.ok).toBe('yes');
  });

  it('redacts capability URLs, keys, emails and PEM blocks in strings', () => {
    expect(redactString('GET /p/abcdefghijklmnopqrstuv/pass.pkpass')).toBe(
      'GET /p/[redacted]/pass.pkpass',
    );
    expect(redactString('https://x/auth/magic?t=secret123&x=1')).toBe(
      'https://x/auth/magic?t=[redacted]&x=1',
    );
    expect(redactString('key wlt_abc_def')).toBe('key wlt_[redacted]');
    expect(redactString('mail me@example.com')).toBe('mail [redacted email]');
    expect(redactString('-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----')).toBe(
      '[redacted pem]',
    );
  });

  it('writes one JSON line with the base context', () => {
    const lines: string[] = [];
    const log = createLogger(
      { requestId: 'r1' },
      { sink: (l) => lines.push(l), now: () => 5 },
    ).child({ orgId: 'o1' });
    log.info('pass.created', { code: 'OK', token: 'secret' });
    log.debug('skipped');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'info',
      event: 'pass.created',
      at: 5,
      requestId: 'r1',
      orgId: 'o1',
      code: 'OK',
      token: '[redacted]',
    });
  });

  it('handles errors and deep objects without throwing', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => redact({ error: new Error('boom'), deep })).not.toThrow();
  });
});
