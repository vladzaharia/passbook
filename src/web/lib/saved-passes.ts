/**
 * Deletes every pass saved to this phone and unregisters their workers, so a shared phone keeps no
 * barcode after sign-out. The save code loads only here, on sign-out; a failure never holds it back.
 */
export async function clearSavedPasses(): Promise<void> {
  try {
    // Bounded: a stuck cache or registry never holds sign-out back.
    await Promise.race([
      import('../portal/save-client.ts').then((m) => m.clearAll()),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Cache Storage or the worker registry refused: leaving matters more than the cleanup.
  }
}
