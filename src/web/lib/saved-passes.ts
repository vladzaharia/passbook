/**
 * Deletes every pass saved to this phone and unregisters their workers, so a shared phone keeps no
 * barcode after sign-out. The save code loads only here, on sign-out; a failure never holds it back.
 */
export async function clearSavedPasses(): Promise<void> {
  try {
    await (await import('../portal/save-client.ts')).clearAll();
  } catch {
    // Cache Storage or the worker registry refused: leaving matters more than the cleanup.
  }
}
