/**
 * The browser's memory of a send whose outcome it never saw. It blocks another send, but never
 * for good: it ends when the server shows nothing reserved or its TTL runs out.
 */
export type LocalOutcome = 'unconfirmed' | 'prepared' | 'accepted';

const FENCE_PREFIX = 'test-inbox-forward:';
/** No unresolved send blocks another for longer than this, whatever the server says. */
export const FENCE_TTL = 2 * 60_000;
/** A request already on the wire may still land; the server's `none` is trusted only after this. */
export const FENCE_GRACE = 15_000;

interface Fence {
  value: LocalOutcome;
  at: number;
}

export function readFence(id: string): Fence | undefined {
  try {
    const raw = localStorage.getItem(`${FENCE_PREFIX}${id}`);
    if (raw === null) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'value' in parsed && 'at' in parsed) {
        const { value, at } = parsed as { value: unknown; at: unknown };
        if (typeof at === 'number') {
          return {
            value: value === 'prepared' || value === 'accepted' ? value : 'unconfirmed',
            at,
          };
        }
      }
    } catch {
      // An older build stored the bare outcome with no time.
    }
    return { value: raw === 'prepared' || raw === 'accepted' ? raw : 'unconfirmed', at: 0 };
  } catch {
    return undefined;
  }
}

export function writeFence(id: string, fence: Fence | undefined) {
  try {
    if (fence === undefined) localStorage.removeItem(`${FENCE_PREFIX}${id}`);
    else localStorage.setItem(`${FENCE_PREFIX}${id}`, JSON.stringify(fence));
  } catch {
    // The mutation cache still holds the fence while this tab remains open.
  }
}
