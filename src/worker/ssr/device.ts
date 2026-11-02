/** Which add path a visitor has, from the user agent (ux-principles.md, Apple rules). */
export type PassDevice = 'iphone' | 'mac' | 'other';

/**
 * iPhone and iPod add to Wallet; so does a Mac. iPadOS reports a Mac user agent, so `mac` pages
 * also carry the iPad lines and let `pointer: coarse` decide in CSS. Everything else (old iPad
 * user agents, Android, Windows, unknown) cannot add.
 */
export function passDevice(ua: string | undefined): { device: PassDevice; inApp: boolean } {
  const text = ua ?? '';
  const device: PassDevice = /iPhone|iPod/.test(text)
    ? 'iphone'
    : /Macintosh/.test(text)
      ? 'mac'
      : 'other';
  // Google app, Facebook, Instagram and Outlook open links in their own view. Other web views on
  // iPhone and iPad (LinkedIn, X, TikTok, Snapchat) are WKWebView and omit the `Safari/` token.
  const apple = /iPhone|iPod|iPad|Macintosh/.test(text);
  const inApp =
    /\bGSA\/|FBAN|FBAV|Instagram|Outlook/.test(text) || (apple && !/Safari\//.test(text));
  return { device, inApp };
}
