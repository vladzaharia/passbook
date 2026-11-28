import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import {
  ScanHelpKindSchema,
  ScanHelpLevelSchema,
  ScanHelpRequesterClassSchema,
  ScanHelpResolvedBySchema,
  ScanHelpTopicSchema,
} from './scan-help.ts';
import { DeviceRoleSchema } from './scanners.ts';

/**
 * The only source of these webhook names. SD3 adds them to `WEBHOOK_EVENT_TYPES` when it
 * emits them, so an endpoint never subscribes to an event that cannot fire.
 */
export const SCAN_HELP_WEBHOOK_EVENTS = [
  'help_request.opened',
  'help_request.escalated',
  'help_request.resolved',
  'help_request.expired',
  'scanner.status_changed',
] as const;
export const ScanHelpWebhookEventSchema = z.enum(SCAN_HELP_WEBHOOK_EVENTS);
export type ScanHelpWebhookEvent = z.infer<typeof ScanHelpWebhookEventSchema>;

const helpData = {
  requestId: IdSchema,
  sessionId: IdSchema,
  scannerId: IdSchema,
  requesterClass: ScanHelpRequesterClassSchema,
  kind: ScanHelpKindSchema,
  topic: ScanHelpTopicSchema,
  level: ScanHelpLevelSchema,
  raisedAt: TimestampSchema,
};

export const HelpRequestOpenedDataSchema = z.object(helpData);
export const HelpRequestEscalatedDataSchema = z.object({
  ...helpData,
  level: z.literal('escalated'),
});
export const HelpRequestResolvedDataSchema = z.object({
  ...helpData,
  outcome: z.enum(['approved', 'denied', 'handled', 'cancelled']),
  resolvedBy: ScanHelpResolvedBySchema,
});
export const HelpRequestExpiredDataSchema = z.object({
  ...helpData,
  stage: z.enum(['request', 'grant']),
});
export const ScannerStatusSchema = z.enum([
  'offline',
  'online',
  'paused',
  'resumed',
  'lookup_locked',
  'network_refused',
]);
/** Kiosks only in v1. */
export const ScannerStatusChangedDataSchema = z.object({
  scannerId: IdSchema,
  sessionId: IdSchema,
  deviceRole: DeviceRoleSchema,
  status: ScannerStatusSchema,
});

export const SCAN_HELP_WEBHOOK_DATA = {
  'help_request.opened': HelpRequestOpenedDataSchema,
  'help_request.escalated': HelpRequestEscalatedDataSchema,
  'help_request.resolved': HelpRequestResolvedDataSchema,
  'help_request.expired': HelpRequestExpiredDataSchema,
  'scanner.status_changed': ScannerStatusChangedDataSchema,
} as const satisfies Record<ScanHelpWebhookEvent, z.ZodType>;
