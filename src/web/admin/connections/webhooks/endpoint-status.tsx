import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { StatusPill } from '../../../ui/index.ts';
import { endpointState, STATE_STATUS, stateLabel } from './health.ts';

/** Active, Failing for 3 h, Paused or Disabled: an icon and words, never colour alone. */
export function EndpointStatus({ endpoint, now }: { endpoint: WebhookEndpointDto; now: number }) {
  return (
    <StatusPill status={STATE_STATUS[endpointState(endpoint)]}>
      {stateLabel(endpoint, now)}
    </StatusPill>
  );
}
