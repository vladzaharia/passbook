import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from './context.ts';
import { handleError } from './error-handler.ts';
import { NotFoundError } from './errors.ts';
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

describe('error logging', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(JSON.parse(line)), now: () => 1 });
    return { lines, log };
  };

  it('keeps the code of an AppError and a redacted stack at error level', () => {
    const { lines, log } = capture();
    const error = new NotFoundError('Gone for jo@example.com.', 'PASS_NOT_FOUND');
    log.error('x.failed', { error });
    const entry = lines[0] as {
      code: string;
      error: { code: string; message: string; stack: string };
    };
    expect(entry.code).toBe('PASS_NOT_FOUND');
    expect(entry.error.code).toBe('PASS_NOT_FOUND');
    expect(entry.error.message).not.toContain('jo@example.com');
    expect(entry.error.stack).toContain('NotFoundError');
    expect(entry.error.stack.split('\n').length).toBeLessThanOrEqual(9);
  });

  it('serializes the cause two levels deep and omits stacks below error level', () => {
    const { lines, log } = capture();
    const deep = new Error('l3', { cause: new Error('l4') });
    log.warn('x.warn', {
      code: 'X',
      error: new Error('l1', { cause: new Error('l2', { cause: deep }) }),
    });
    const error = (lines[0] as { error: Record<string, unknown> }).error;
    expect(error.stack).toBeUndefined();
    const l2 = error.cause as Record<string, unknown>;
    const l3 = l2.cause as Record<string, unknown>;
    expect(l2.message).toBe('l2');
    expect(l3).toBeDefined();
    expect(l3.cause).toBeUndefined();
  });
});

describe('request.failed', () => {
  it('logs method, route template and stack, never the raw path', async () => {
    const lines: Record<string, unknown>[] = [];
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'r1');
      c.set(
        'log',
        createLogger({}, { sink: (line) => lines.push(JSON.parse(line)), now: () => 1 }),
      );
      await next();
    });
    app.get('/p/:token', () => {
      throw new Error('boom');
    });
    app.onError(handleError);
    const response = await app.request('/p/secret-token-value-0123456789');
    expect(response.status).toBe(500);
    const entry = lines.find((l) => l.event === 'request.failed') as Record<string, unknown>;
    expect(entry.route).toBe('/p/:token');
    expect(entry.method).toBe('GET');
    expect((entry.error as { stack: string }).stack).toContain('boom');
    expect(JSON.stringify(entry)).not.toContain('secret-token-value');
  });
});

describe('scan codes and barcodes', () => {
  it('are redacted by key', () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(JSON.parse(line)), now: () => 1 });
    log.info('pass.scan', {
      scanCode: 'S3CRET',
      scan_code: 'S3CRET',
      barcodeValue: 'B4RCODE',
      ok: 1,
    });
    const entry = JSON.stringify(lines[0]);
    expect(entry).not.toContain('S3CRET');
    expect(entry).not.toContain('B4RCODE');
    expect(lines[0]?.ok).toBe(1);
  });
});
