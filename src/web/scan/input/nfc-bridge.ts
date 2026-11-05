/**
 * The native NFC bridge: an interface only. A future shell (a WKWebView app reading VAS passes with
 * ProximityReader) injects `window.passbookNative.nfc`. On the web there is none.
 */
export interface NfcBridge {
  /** Hardware and entitlement are present. */
  available(): Promise<boolean>;
  /** One read through the system sheet. Resolves with the decrypted VAS message; rejects on cancel or timeout. */
  read(options?: { signal?: AbortSignal }): Promise<{ message: string }>;
}

export function detectNfcBridge(): NfcBridge | null {
  const native = (globalThis as { passbookNative?: { nfc?: NfcBridge } }).passbookNative;
  return native?.nfc ?? null;
}
