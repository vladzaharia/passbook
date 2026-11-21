/** save.js (shared/pass-offline.ts) loads on every page; this is the part sign-out uses. */
interface PassSave {
  clearAll(): Promise<void>;
}

/**
 * Deletes every pass saved to this phone and unregisters their workers, so a shared phone keeps no
 * barcode after sign-out. A failure here never holds the sign-out back.
 */
export async function clearSavedPasses(): Promise<void> {
  const saver = (window as unknown as { PassSave?: PassSave }).PassSave;
  if (!saver) return;
  try {
    await saver.clearAll();
  } catch {
    // Cache Storage or the worker registry refused: leaving matters more than the cleanup.
  }
}
