/** SA-14: one short pulse for ok, two for a heads-up, three for a refusal. Milliseconds on, off, on... */
export const HAPTIC_PATTERNS: Record<string, readonly number[]> = {
  ok: [40],
  heads_up: [40, 70, 40],
  refused: [40, 70, 40, 70, 40],
};

interface Bridge {
  postMessage(message: string): void;
}

/**
 * Buzz once for a verdict: through the native shell's bridge when there is one, else the Vibration
 * API (Android browsers; iOS Safari has none and gets nothing). Returns whether a buzz was sent.
 */
export function buzz(
  kind: string,
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
  nav: Pick<Navigator, 'vibrate'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): boolean {
  const base = HAPTIC_PATTERNS[kind];
  if (!base) return false;
  const pattern = [...base];
  if (bridge) {
    bridge.postMessage(JSON.stringify({ version: 1, op: 'haptic', pattern }));
    return true;
  }
  return typeof nav?.vibrate === 'function' && nav.vibrate(pattern);
}
