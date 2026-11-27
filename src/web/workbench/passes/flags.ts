import type { WbContext } from '../host/contexts.ts';

/**
 * Whether a sandbox's device pass (design §3.4, S4) is on. It is off until S4 lands and its
 * `DEVICE_PASS_ENABLED` reaches the client: with it off, Add to my phone and a sandbox's On my phone
 * view are absent, never disabled (§6). An org's Test never has them; it opens its passes' own links.
 */
export function useDevicePassEnabled(_context: WbContext): boolean {
  return false;
}
