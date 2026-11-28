import type { WbContext } from '../host/contexts.ts';

/**
 * Whether a sandbox's device pass (design §3.4, S4) is on: the server's `DEVICE_PASS_ENABLED`, read from
 * the contexts the shell already loads. Off, Add to my phone and a sandbox's On my phone view are absent,
 * never disabled (§6). An org's Test never has them; it opens its passes' own links.
 */
export function useDevicePassEnabled(context: WbContext): boolean {
  return context.kind === 'sandbox' && !context.closed && context.devicePass === true;
}
