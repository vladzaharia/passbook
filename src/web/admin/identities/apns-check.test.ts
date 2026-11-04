import { describe, expect, it } from 'vitest';
import { failureSentence } from './apns-check.tsx';

describe('failureSentence', () => {
  it('maps Apple reason codes to one sentence', () => {
    expect(failureSentence('BadCertificate', 403)).toBe(
      'Apple rejected the push certificate. Upload a new one.',
    );
    expect(failureSentence(null, 403)).toBe(
      'Apple rejected the push certificate. Upload a new one.',
    );
    expect(failureSentence('TopicDisallowed', 400)).toMatch(/pass type/);
    expect(failureSentence('NetworkError')).toBe('Could not reach Apple. Try again.');
    expect(failureSentence('PushUnavailable', 0)).toBe(
      'Push is not set up. Add a push key or a certificate binding.',
    );
    expect(failureSentence('InvalidProviderToken', 403, 'key')).toMatch(/push key/);
    expect(failureSentence('NetworkError', 0, 'key')).toMatch(/APNS_TOKEN_TRANSPORT_FAILED/);
    expect(failureSentence('TooManyRequests', 429)).toBe(
      'Apple gave no clear answer. Try again later.',
    );
  });
});
