import { zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  ApiKeyActivitySchema,
  ApiKeyDetailSchema,
  ApiKeyMeSchema,
  MintedApiKeySchema,
  RetiredApiKeySchema,
  RotatedApiKeySchema,
} from '../../shared/contracts/api-keys.ts';
import { BroadcastSchema } from '../../shared/contracts/broadcasts.ts';
import { BroadcastUndoResultSchema } from '../../shared/contracts/broadcasts-change.ts';
import { CliTokenEndedSchema } from '../../shared/contracts/cli.ts';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { ConnectionPreviewSchema } from '../../shared/contracts/connection-preview.ts';
import { OrgBrandingSchema, OrgSchema, OrgSummarySchema } from '../../shared/contracts/orgs.ts';
import { BulkRunSchema, CurrentBulkRunSchema } from '../../shared/contracts/pass-bulk-runs.ts';
import {
  PassImportUndoResultSchema,
  SavedImportMappingsResultSchema,
} from '../../shared/contracts/pass-imports.ts';
import { PassFilterSchema } from '../../shared/contracts/pass-selection.ts';
import {
  PassSetupResultSchema,
  PassSetupSchema,
  StagedBrandAssetSchema,
} from '../../shared/contracts/pass-setup.ts';
import { PassViewListSchema } from '../../shared/contracts/pass-views.ts';
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
import { ScanSetupAnswerSchema } from '../../shared/contracts/scan-setup-intent.ts';
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
  ReleaseResponseSchema,
  ReleaseTemplateSchema,
  ReviewResultSchema,
  ReviewTemplateSchema,
  TemplateReviewListSchema,
} from '../../shared/contracts/template-release-flow.ts';
import { TemplateRolloutSchema } from '../../shared/contracts/template-rollout.ts';
import {
  TemplateDetailSchema,
  TemplateInputSchemaSchema,
  TemplateListSchema,
  TemplateSummarySchema,
} from '../../shared/contracts/templates.ts';
import { WalletReissueResponseSchema } from '../../shared/contracts/wallet-provider-actions.ts';
import {
  CaptureEndpointCreatedSchema,
  CaptureSecretSchema,
  WebhookCaptureListSchema,
  WebhookCaptureSchema,
} from '../../shared/contracts/webhook-captures.ts';
import { WebhookTestAttemptListSchema } from '../../shared/contracts/webhook-tests.ts';
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
  Broadcast: BroadcastSchema,
  BroadcastUndo: BroadcastUndoResultSchema,
  ConnectionPreview: ConnectionPreviewSchema,
  TemplateRollout: TemplateRolloutSchema,
  PassImportMappings: SavedImportMappingsResultSchema,
  PassImportUndo: PassImportUndoResultSchema,
  PassSummary: PassSummarySchema,
  PassDetail: PassDetailSchema,
  PassVersion: PassVersionSchema,
  PassDevice: PassDeviceSchema,
  PassPage: PassListSchema,
  PassViews: PassViewListSchema,
  BulkRun: BulkRunSchema,
  CurrentBulkRun: CurrentBulkRunSchema,
  PassFilter: PassFilterSchema,
  ApiKeyCurrent: ApiKeyMeSchema,
  ApiKeyMinted: MintedApiKeySchema,
  ApiKeyRotation: RotatedApiKeySchema,
  ApiKeyDetail: ApiKeyDetailSchema,
  ApiKeyActivity: ApiKeyActivitySchema,
  ApiKeyRetired: RetiredApiKeySchema,
  CliTokenEnded: CliTokenEndedSchema,
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
  WebhookTestAttemptPage: WebhookTestAttemptListSchema,
  WebhookCapture: WebhookCaptureSchema,
  WebhookCapturePage: WebhookCaptureListSchema,
  CaptureEndpointCreated: CaptureEndpointCreatedSchema,
  CaptureSecret: CaptureSecretSchema,
  EventPage: EventFeedPageSchema,
  ScanSetupAnswer: ScanSetupAnswerSchema,
  ReleaseTemplate: ReleaseTemplateSchema,
  ReleaseResponse: ReleaseResponseSchema,
  ReviewTemplate: ReviewTemplateSchema,
  ReviewResult: ReviewResultSchema,
  TemplateReviewList: TemplateReviewListSchema,
  PassSetup: PassSetupSchema,
  PassSetupResult: PassSetupResultSchema,
  StagedBrandAsset: StagedBrandAssetSchema,
  WalletReissue: WalletReissueResponseSchema,
};

for (const [refId, schema] of Object.entries(names))
  zodToOpenAPIRegistry.add(schema, { _internal: { refId } });
