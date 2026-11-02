import { describe, expect, it } from 'vitest';
import { passDevice } from './device';

const SAFARI = 'Version/18.0 Mobile/15E148 Safari/604.1';

describe('passDevice', () => {
  it.each([
    [`Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ${SAFARI}`, 'iphone', false],
    [`Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) ${SAFARI}`, 'iphone', false],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 'mac', false],
    [`Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ${SAFARI}`, 'other', false],
    ['Mozilla/5.0 (Linux; Android 14) [FBAN/FB4A;FBAV/450.0]', 'other', true],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0', 'iphone', true],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [LinkedInApp]',
      'iphone',
      true,
    ],
    [undefined, 'other', false],
  ])('%s', (ua, device, inApp) => {
    expect(passDevice(ua)).toEqual({ device, inApp });
  });
});
