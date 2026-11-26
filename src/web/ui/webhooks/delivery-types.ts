import type { ReactNode } from 'react';
import type { z } from 'zod';
import type {
  WebhookDeliveryDetailSchema,
  WebhookDeliverySchema,
  WebhookEndpointStatus,
} from '@/shared/contracts/webhooks.ts';
import type { TestRow } from '@/shared/webhook-test-rows.ts';

export type Delivery = z.infer<typeof WebhookDeliverySchema>;
export type DeliveryDetail = z.infer<typeof WebhookDeliveryDetailSchema>;

/** A delivery in a list, with the endpoint it went to when the list spans endpoints. */
export type DeliveryRowData = Delivery & {
  endpointId?: string;
  /** The endpoint's host or "Capture endpoint". */
  endpointName?: string;
  endpointStatus?: WebhookEndpointStatus;
  /** What a row opens, when it is not the event (a capture's id). */
  rowId?: string;
  /** A test send, kept as a capture: it wears the Test tag and names no pass. */
  test?: true;
};
export type DeliveryListRow = DeliveryRowData | TestRow;
export const isTestRow = (r: DeliveryListRow): r is TestRow => 'key' in r;
export const rowKey = (r: DeliveryListRow): string =>
  isTestRow(r) ? r.key : (r.rowId ?? `${r.endpointId ?? ''}:${r.eventId}`);

/**
 * What differs between the hosts. Admin links a pass to its admin page and may replay on a
 * manager's session; the Workbench links it to Passes in Test and replays on the token.
 */
export interface DeliveryHost {
  canManage: boolean;
  /** The pass a delivery is about, as a link in the host's own routes: small in a list, plain in the inspector. */
  passLink: (
    d: { passId: string; externalId: string | null; label: string },
    place: 'list' | 'inspector',
  ) => ReactNode;
}

/** The query state the inspector draws: a React Query result or the Workbench's own read. */
export interface DeliveryRead {
  isPending: boolean;
  isError: boolean;
  data: DeliveryDetail | undefined;
  error: unknown;
  refetch: () => void;
}
