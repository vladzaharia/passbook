/**
 * In-app browsers cannot add a pass to Wallet: the Google app, Facebook, Instagram and Outlook by
 * name, and any other iPhone or iPad web view (LinkedIn, X, TikTok…), which lacks Safari's token.
 */
export function isInAppBrowser(ua: string): boolean {
  if (/\bGSA\/|FBAN|FBAV|Instagram|Outlook/.test(ua)) return true;
  return /iPhone|iPod|iPad/.test(ua) && !/Safari\//.test(ua);
}
