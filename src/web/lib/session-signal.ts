const CHANNEL = 'wallet-session';

/** Tells the other tabs of this browser that the session ended or the account changed here. */
export function announceSessionEnd(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('end');
  channel.close();
}

/** Calls `fn` when another tab announces it. Returns what stops listening. */
export function onSessionEnd(fn: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = fn;
  return () => channel.close();
}
