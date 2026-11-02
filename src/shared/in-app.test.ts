import { describe, expect, it } from 'vitest';
import { isInAppBrowser } from './in-app.ts';

const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('isInAppBrowser', () => {
  it('names the known apps and any iOS web view without the Safari token', () => {
    expect(isInAppBrowser(SAFARI.replace('Version/18.0', 'GSA/350.0'))).toBe(true);
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]',
      ),
    ).toBe(true);
  });

  it('leaves Safari, Chrome on iOS and desktop browsers alone', () => {
    expect(isInAppBrowser(SAFARI)).toBe(false);
    expect(isInAppBrowser(SAFARI.replace('Version/18.0', 'CriOS/126.0'))).toBe(false);
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe(false);
    expect(
      isInAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36'),
    ).toBe(false);
  });
});
