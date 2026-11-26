// The calls the contract recorder makes, per provider. Pure data: nothing here sends anything.

export const GOOGLE_RECORD_TYPES = [
  'generic',
  'loyalty',
  'giftCard',
  'eventTicket',
  'offer',
] as const;
export type GoogleRecordType = (typeof GOOGLE_RECORD_TYPES)[number];
export const SAMSUNG_RECORD_TYPES = ['loyalty', 'ticket', 'coupon'] as const;
export type SamsungRecordType = (typeof SAMSUNG_RECORD_TYPES)[number];

export interface PlannedCall {
  /** A fixture file stem: `<type>-<step>`. */
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** Path under the provider's API origin. */
  path: string;
  body?: unknown;
}

export const GOOGLE_API = 'https://walletobjects.googleapis.com/walletobjects/v1';
export const SAMSUNG_API = 'https://tsapi-card.walletsvc.samsung.com';

/** Google's REST resource names are the type with Class or Object appended. */
export function googleCalls(issuer: string, type: GoogleRecordType, suffix: string): PlannedCall[] {
  const classId = `${issuer}.${suffix}-class`;
  const objectId = `${issuer}.${suffix}-object`;
  const cls = `/${type}Class`;
  const obj = `/${type}Object`;
  return [
    {
      name: `${type}-class-insert`,
      method: 'POST',
      path: cls,
      body: { id: classId, reviewStatus: 'UNDER_REVIEW' },
    },
    { name: `${type}-class-get`, method: 'GET', path: `${cls}/${classId}` },
    {
      name: `${type}-object-insert`,
      method: 'POST',
      path: obj,
      body: { id: objectId, classId, state: 'ACTIVE' },
    },
    {
      name: `${type}-object-patch`,
      method: 'PATCH',
      path: `${obj}/${objectId}`,
      body: { state: 'INACTIVE' },
    },
    { name: `${type}-object-get`, method: 'GET', path: `${obj}/${objectId}` },
    {
      name: `${type}-add-message`,
      method: 'POST',
      path: `${obj}/${objectId}/addMessage`,
      body: {
        message: { id: 'rec-m1', header: 'PassBook test', body: 'Recorded', messageType: 'TEXT' },
      },
    },
  ];
}

/**
 * Update Notification per event for one card. Generic and gift cards have no Update Notification, so those are not
 * planned. Get Card Data and Send Card State are Samsung calling us: record them with `--scrub-capture`.
 */
export function samsungCalls(
  cc2: string,
  cardId: string,
  type: SamsungRecordType,
  refId: string,
): PlannedCall[] {
  const path = `/${cc2}/wltex/cards/${cardId}/updates`;
  return ['UPDATED', 'CANCELED', 'ACTIVE', 'EXPIRED', 'DELETED'].map((state) => ({
    name: `${type}-update-${state.toLowerCase()}`,
    method: 'POST' as const,
    path,
    body: { card: { type, data: [{ refId, state }] } },
  }));
}
