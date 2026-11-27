import { getNativeCapabilities } from './native-capabilities.ts';

/** SA-14: one short pulse for ok, two for a heads-up, three for a refusal, one long one for a system verdict. Milliseconds on, off, on... */
export const HAPTIC_PATTERNS = {
  ok: [40],
  heads_up: [40, 70, 40],
  refused: [40, 70, 40, 70, 40],
  system: [200],
} as const;

interface Bridge {
  postMessage(message: string): void;
}

let sender: ((pattern: number[]) => void) | null = null;
/** The native reader's haptic at its negotiated version; set only for an app that listed `scanSettle`. */
export function setHapticSender(send: ((pattern: number[]) => void) | null) {
  sender = send;
}

/** Clears the sender only if it is still `send`, so a late dispose cannot unset a newer runtime's. */
export function clearHapticSender(send: (pattern: number[]) => void) {
  if (sender === send) sender = null;
}

/** Whether this device can buzz at all: a native shell that plays the op, or the Vibration API (not iOS Safari). */
export function canBuzz(
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
  nav: Pick<Navigator, 'vibrate'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
  native: boolean = getNativeCapabilities()?.haptics === true,
): boolean {
  return Boolean(sender) || Boolean(bridge && native) || typeof nav?.vibrate === 'function';
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
  native: boolean = getNativeCapabilities()?.haptics === true,
): boolean {
  if (!Object.hasOwn(HAPTIC_PATTERNS, kind)) return false;
  const pattern = [...HAPTIC_PATTERNS[kind as keyof typeof HAPTIC_PATTERNS]];
  if (sender) {
    sender(pattern);
    return true;
  }
  // Only a shell that says it plays the op gets it; every other shell would drop it.
  if (bridge && native) {
    bridge.postMessage(JSON.stringify({ version: 1, op: 'haptic', pattern }));
    return true;
  }
  return typeof nav?.vibrate === 'function' && nav.vibrate(pattern);
}
