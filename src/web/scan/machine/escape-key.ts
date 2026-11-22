/** What Escape does on the scanner: close the Manager PIN form first, then leave the assign. */
export function escapeEvent(
  overlayOpen: boolean,
  pinOpen: boolean,
): { type: 'assign.pin'; open: false } | { type: 'dismiss' } | null {
  if (overlayOpen) return null;
  return pinOpen ? { type: 'assign.pin', open: false } : { type: 'dismiss' };
}
