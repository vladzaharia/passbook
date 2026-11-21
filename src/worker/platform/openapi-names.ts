import { zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  ApiKeyActivitySchema,
  ApiKeyDetailSchema,
  ApiKeyMeSchema,
  MintedApiKeySchema,
  RetiredApiKeySchema,
  RotatedApiKeySchema,
} from '../../shared/contracts/api-keys.ts';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { OrgBrandingSchema, OrgSchema, OrgSummarySchema } from '../../shared/contracts/orgs.ts';
import {
  PassDetailSchema,
  PassDeviceSchema,
  PassListSchema,
  PassSummarySchema,
  PassVersionSchema,
} from '../../shared/contracts/passes.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
  CapturedEmailSchema,
} from '../../shared/contracts/sandbox.ts';
import {
  ScanCardActionSchema,
  ScanCardSchema,
  ScanCountsSchema,
  ScannerSettingsSchema,
  ScanOutcomeSchema,
  ScanPreviousSchema,
  ScanTemplateRefSchema,
} from '../../shared/contracts/scan.ts';
import {
  ScanBatchResultSchema,
  ScanBrandingSchema,
  ScanLookupRowSchema,
  ScanRecentSchema,
  ScanRosterSchema,
  ScanSessionSchema,
  ScanSummarySchema,
} from '../../shared/contracts/scan-session.ts';
import {
  CreatedScannerSchema,
  ScanEventLiveSchema,
  ScanEventSchema,
  ScanFeedRowSchema,
  ScannerSchema,
  ScanRecordSchema,
  ScanStaffSchema,
} from '../../shared/contracts/scanners.ts';
import {
  CreatedScanningDeviceSchema,
  NativeScannerCapabilitiesSchema,
  ScanDeviceCapabilitiesSchema,
  ScanningDeviceSchema,
  ScanningSessionDetailSchema,
  ScanningSessionSchema,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../shared/contracts/scanning-sessions.ts';
import {
  TemplateDetailSchema,
  TemplateInputSchemaSchema,
  TemplateListSchema,
  TemplateSummarySchema,
} from '../../shared/contracts/templates.ts';
import {
  CaptureEndpointCreatedSchema,
  CaptureSecretSchema,
  WebhookCaptureListSchema,
  WebhookCaptureSchema,
} from '../../shared/contracts/webhook-captures.ts';
import {
  EventFeedPageSchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  WebhookEndpointCreatedSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  WebhookTestResultSchema,
} from '../../shared/contracts/webhooks.ts';

/**
 * Component schema names for the OpenAPI document. Registered here, not with `.meta()` in the
 * contracts, so the web bundle and the contract files stay as they are. A name is part of the
 * published API (SDK type names): add, never rename.
 */
const names = {
  Problem: ProblemSchema,
  ScanOutcome: ScanOutcomeSchema,
  ScannerSettings: ScannerSettingsSchema,
  ScanCard: ScanCardSchema,
  ScanCounts: ScanCountsSchema,
  ScanCardAction: ScanCardActionSchema,
  ScanPrevious: ScanPreviousSchema,
  ScanTemplateRef: ScanTemplateRefSchema,
  ScanSession: ScanSessionSchema,
  ScanBranding: ScanBrandingSchema,
  ScanSummary: ScanSummarySchema,
  ScanRoster: ScanRosterSchema,
  ScanBatchResult: ScanBatchResultSchema,
  ScanLookupRow: ScanLookupRowSchema,
  ScanRecent: ScanRecentSchema,
  ScanningSession: ScanningSessionSchema,
  ScanningDevice: ScanningDeviceSchema,
  ScanningSessionDetail: ScanningSessionDetailSchema,
  ScanDeviceCapabilities: ScanDeviceCapabilitiesSchema,
  NativeScannerCapabilities: NativeScannerCapabilitiesSchema,
  ScanWorkspace: ScanWorkspaceSchema,
  SessionActivity: SessionActivitySchema,
  CreatedScanningDevice: CreatedScanningDeviceSchema,
  Scanner: ScannerSchema,
  ScanEvent: ScanEventSchema,
  ScanRecord: ScanRecordSchema,
  ScanStaff: ScanStaffSchema,
  ScanFeedRow: ScanFeedRowSchema,
  ScanEventLive: ScanEventLiveSchema,
  CreatedScanner: CreatedScannerSchema,
  Org: OrgSchema,
  OrgSummary: OrgSummarySchema,
  OrgBranding: OrgBrandingSchema,
  PassSummary: PassSummarySchema,
  PassDetail: PassDetailSchema,
  PassVersion: PassVersionSchema,
  PassDevice: PassDeviceSchema,
  PassPage: PassListSchema,
  ApiKeyCurrent: ApiKeyMeSchema,
  ApiKeyMinted: MintedApiKeySchema,
  ApiKeyRotation: RotatedApiKeySchema,
  ApiKeyDetail: ApiKeyDetailSchema,
  ApiKeyActivity: ApiKeyActivitySchema,
  ApiKeyRetired: RetiredApiKeySchema,
  TemplateSummary: TemplateSummarySchema,
  TemplateDetail: TemplateDetailSchema,
  TemplateInputSchema: TemplateInputSchemaSchema,
  TemplatePage: TemplateListSchema,
  CapturedEmail: CapturedEmailSchema,
  CapturedEmailDetail: CapturedEmailDetailSchema,
  CapturedEmailPage: CapturedEmailListSchema,
  WebhookEndpoint: WebhookEndpointSchema,
  WebhookEndpointCreated: WebhookEndpointCreatedSchema,
  WebhookEndpointPage: WebhookEndpointListSchema,
  WebhookDeliveryPage: WebhookDeliveryListSchema,
  WebhookDeliveryDetail: WebhookDeliveryDetailSchema,
  WebhookTestResult: WebhookTestResultSchema,
  WebhookCapture: WebhookCaptureSchema,
  WebhookCapturePage: WebhookCaptureListSchema,
  CaptureEndpointCreated: CaptureEndpointCreatedSchema,
  CaptureSecret: CaptureSecretSchema,
  EventPage: EventFeedPageSchema,
};

for (const [refId, schema] of Object.entries(names))
  zodToOpenAPIRegistry.add(schema, { _internal: { refId } });
