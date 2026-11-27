import { Link } from '@tanstack/react-router';
import { wbPath } from '@/shared/workbench.ts';
import type { DeliveryHost } from '../../ui/webhooks/delivery-types.ts';

/** The Workbench's host for the shared delivery parts: a pass opens in Passes, in this context's Test. */
export const workbenchDeliveryHost = (orgId: string, canManage: boolean): DeliveryHost => ({
  canManage,
  passLink: ({ passId, externalId, label }, place) => (
    <Link
      to={wbPath(orgId, 'passes', { hash: passId })}
      title={externalId ?? undefined}
      className={`font-normal text-fg-strong underline-offset-2 hover:text-accent-fg hover:underline ${place === 'list' ? 'text-xs' : ''}`}
    >
      {label}
    </Link>
  ),
});
