import { describe, expect, it } from 'vitest';
import { clientOf } from './request-log-client.ts';

describe('clientOf', () => {
  it('names the common tools and keeps a version only for curl', () => {
    expect(clientOf('curl/8.7.1')).toBe('curl/8.7.1');
    expect(clientOf('curl/8')).toBe('curl/8');
    expect(clientOf('node')).toBe('node');
    expect(clientOf('node-fetch/3.3.2')).toBe('node');
    expect(clientOf('python-requests/2.32.3')).toBe('python-requests');
    expect(clientOf('Go-http-client/2.0')).toBe('go');
    expect(clientOf('PostmanRuntime/7.43.0')).toBe('postman');
    expect(clientOf('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15')).toBe(
      'browser',
    );
  });

  it('stores nothing of an unknown, empty or hostile header', () => {
    expect(clientOf(undefined)).toBeNull();
    expect(clientOf('')).toBeNull();
    expect(clientOf('   ')).toBeNull();
    expect(clientOf('my-secret-agent/1.0 user=alice@example.com')).toBeNull();
    expect(clientOf('curl/8.7.1 alice@example.com')).toBe('curl/8.7.1');
    expect(clientOf('x'.repeat(5000))).toBeNull();
  });
});
