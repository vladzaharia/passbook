/**
 * Test helper: the shapes of Samsung's card JSON and Update Notification bodies, written from
 * samsung-wallet.md section 2 (S-card required attributes and limits) and section 4 (S-api). Strict
 * on structure, so a compiler cannot drop a required attribute or send an unknown state.
 */
import { z } from 'zod';
import { measure } from '../text.ts';
import { SAMSUNG_LIMITS } from './limits.ts';

const APP_LINK = ['appLinkLogo', 'appLinkName', 'appLinkData'] as const;
/** The attributes S-card marks required, per type. */
export const REQUIRED: Record<'loyalty' | 'ticket' | 'coupon', readonly string[]> = {
  loyalty: ['title', 'providerName', ...APP_LINK],
  ticket: [
    'title',
    'mainImg',
    'logoImage',
    'providerName',
    'issueDate',
    'reservationNumber',
    'startDate',
    'noticeDesc',
    ...APP_LINK,
  ],
  coupon: [
    'title',
    'mainImg',
    'expiry',
    'issueDate',
    'editableYn',
    'deletableYn',
    'displayRedeemButtonYn',
    'notificationYn',
    ...APP_LINK,
  ],
};
const SUBTYPES = {
  loyalty: ['others'],
  ticket: ['performances', 'sports', 'movies', 'entrances', 'others'],
  coupon: ['others'],
} as const;
/** Get Card Data: each data[] carries a state (samsung-wallet.md section 4 and 5). */
export const CARD_STATES = [
  'ACTIVE',
  'CANCELED',
  'EXPIRED',
  'SUSPENDED',
  'HELD',
  'REDEEMED',
] as const;
/** Update Notification states, exactly as section 4 lists them. */
export const NOTIFICATION_STATES = [
  'ACTIVE',
  'UPDATED',
  'EXPIRED',
  'REDEEMED',
  'HELD',
  'DELETED',
  'SUSPENDED',
  'MIGRATED',
] as const;

const attributes = (type: keyof typeof REQUIRED) =>
  z.record(z.string(), z.string()).superRefine((attrs, ctx) => {
    for (const key of REQUIRED[type])
      if (!attrs[key]) ctx.addIssue({ code: 'custom', message: `missing ${key}`, path: [key] });
    for (const [key, limit] of Object.entries(SAMSUNG_LIMITS) as [string, { max: number }][]) {
      const value = attrs[key];
      if (value !== undefined && measure(value, 'bytes') > limit.max)
        ctx.addIssue({ code: 'custom', message: `${key} over ${limit.max} bytes`, path: [key] });
    }
  });

/** The `{card:{type,subType,data[]}}` body of Get Card Data (and of a card token's payload). */
export const cardBody = (type: keyof typeof REQUIRED) =>
  z.strictObject({
    card: z.strictObject({
      type: z.literal(type),
      subType: z.enum(SUBTYPES[type]),
      data: z
        .array(
          z.strictObject({
            // 32 is the token and Get Card Data limit; S-ov's 128 is unconfirmed [U].
            refId: z.string().min(1).max(32),
            state: z.enum(CARD_STATES),
            createdAt: z.number(),
            updatedAt: z.number(),
            language: z.string().max(8),
            attributes: attributes(type),
            localization: z
              .array(
                z.strictObject({
                  language: z.string().max(8),
                  attributes: z.record(z.string(), z.string()),
                }),
              )
              .optional(),
          }),
        )
        .min(1)
        .max(6),
    }),
  });

/** The body of Update Notification: `{card:{type,data:[{refId,state}]}}`. */
export const updateNotification = z.strictObject({
  card: z.strictObject({
    type: z.enum(['loyalty', 'ticket', 'coupon']),
    data: z
      .array(z.strictObject({ refId: z.string().min(1), state: z.enum(NOTIFICATION_STATES) }))
      .min(1)
      .max(6),
  }),
});
