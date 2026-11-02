/**
 * In-app browsers cannot add a pass to Wallet: the Google app, Facebook, Instagram and Outlook by
 * name, and any other Apple web view (LinkedIn, X, TikTok, Snapchat…): WKWebView omits Safari's
 * `Safari/` token. iPadOS apps report a Mac user agent, so Macs count too.
 */
export function isInAppBrowser(ua: string): boolean {
  if (/\bGSA\/|FBAN|FBAV|Instagram|Outlook/.test(ua)) return true;
  return /iPhone|iPod|iPad|Macintosh/.test(ua) && !/Safari\//.test(ua);
}
