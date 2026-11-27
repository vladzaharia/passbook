import { RowLink } from '../../../ui/row-link.tsx';
import type { DeliveryHost } from '../../../ui/webhooks/delivery-types.ts';

/** Admin's host for the shared delivery parts: a pass is an admin page, and a manager replays. */
export const adminDeliveryHost = (canManage: boolean): DeliveryHost => ({
  canManage,
  passLink: ({ passId, externalId, label }, place) => (
    <RowLink
      to="/admin/passes/$passId"
      params={{ passId }}
      title={externalId ?? undefined}
      className={place === 'list' ? 'text-xs font-normal' : 'font-normal'}
    >
      {label}
    </RowLink>
  ),
});
