// Seeds for the IdP-only operations: the console's metrics, the developer portal, wallet accounts and org members.
// Same contract as example-seeds.ts: a partial value the sampler fits to the schema.
import {
  CHANNELS,
  IDENTITY_RUN,
  ROLL_CALL,
  TAG_TYPE,
  TEMPLATE_VERSION,
  VISITOR,
} from './example-canon.ts';
import {
  ACTIVITY,
  CALL,
  DEVELOPER_HOME,
  METRICS,
  SANDBOX,
  SANDBOX_KEY,
  spread,
} from './example-stats.ts';
import { hex, IDS, keySecret, T, TEMPLATE, TEMPLATE_DETAIL } from './example-world.ts';

/** An org's overview: the platform's, without the platform directory cards. */
const ORG_METRICS = Object.fromEntries(Object.entries(METRICS).filter(([k]) => k !== 'directory'));
const uuid = (seed: string): string => `0193a1b2-7c00-7000-8000-${hex(seed, 12)}`;
const DAY = 86_400_000;
const PRIYA = uuid('user-priya');
const INVITATION = {
  id: uuid('invitation-priya'),
  orgId: IDS.org,
  email: 'priya@example.com',
  roles: ['pass_operator'],
  createdAt: T.updated,
  expiresAt: T.updated + 7 * DAY,
  revokedAt: null,
  acceptedAt: null,
};
/** The org's people: Sam runs it, Priya runs the front desk. */
const PEOPLE: Record<string, [name: string, email: string]> = {
  [IDS.user as string]: ['Sam Rivera', 'sam@example.com'],
  [uuid('user-priya')]: ['Priya Nair', 'priya@example.com'],
};
const membership = (userId: string | undefined, roles: string[], createdAt: number) => ({
  id: uuid(`membership-${userId}`),
  orgId: IDS.org,
  orgName: 'Northwind Climbing',
  orgSlug: 'northwind-climbing',
  personal: false,
  testOnly: false,
  userId,
  userName: PEOPLE[userId ?? '']?.[0],
  userEmail: PEOPLE[userId ?? '']?.[1],
  roles,
  createdAt,
  revokedAt: null,
});

/** The gym's Google Wallet issuer account, saved by the org; Google is not released on the platform yet. */
const CREDENTIAL = {
  id: uuid('credential-google'),
  scope: 'org',
  orgId: IDS.org,
  mode: 'live',
  provider: 'google',
  identityHint: 'Issuer 3388000000022843210',
  provenance: 'own',
  revision: 2,
  verifiedAt: T.updated,
  revokedAt: null,
  createdAt: T.created,
  updatedAt: T.updated,
};
const ENROLMENT = {
  mode: 'live',
  provider: 'google',
  accountId: CREDENTIAL.id,
  source: 'org',
  platformAvailable: false,
  state: 'off',
  enrolmentRevision: 2,
  prerequisites: { check: true, roundTrip: false },
  hold: null,
  issuance: { state: 'disabled', reason: 'not_released' },
};
const ACCOUNT = {
  orgId: IDS.org,
  mode: 'live',
  provider: 'google',
  accountId: CREDENTIAL.id,
  revision: 2,
  state: 'configured',
  externalApprovalVerified: true,
  issuance: { state: 'disabled', reason: 'not_released' },
  updatedAt: T.updated,
};
const SANDBOX_ROW = {
  id: SANDBOX.id,
  orgId: SANDBOX.orgId,
  orgSlug: SANDBOX.orgSlug,
  templateId: SANDBOX.templateId,
  previewOnly: true,
  createdAt: SANDBOX.createdAt,
  closedAt: null,
};
const NEW_SANDBOX_KEY = {
  ...SANDBOX_KEY,
  id: uuid('key-sandbox-2'),
  secret: keySecret('r3SetK3y'),
};

const OPEN = {
  orgId: IDS.org,
  status: 'active',
  closedAt: null,
  purgeAfter: null,
  purging: false,
  purged: false,
  held: false,
  canReopen: false,
};

/** Staff notes on Ada's pass (scan-history.ts): the desk's own, one line each. */
const NOTE = {
  id: uuid('note'),
  at: T.recent,
  body: 'Waiver signed on paper; scan it to the file.',
  by: 'Sam Rivera',
  own: true,
  edited: false,
};
const SCOPE = `org:${IDS.org}`;
const SETTINGS = [
  {
    scope: SCOPE,
    key: 'org.timeZone',
    value: 'America/Los_Angeles',
    default: 'UTC',
    source: 'org',
    updatedAt: T.created,
    updatedBy: IDS.user,
  },
  {
    scope: SCOPE,
    key: 'email.orgCapPerDay',
    value: 500,
    default: 500,
    source: 'default',
    ceiling: 2000,
    updatedAt: null,
    updatedBy: null,
  },
];

export const IDP_SEEDS: Record<string, unknown> = {
  // Binding a new wristband to Ada's pass, as the desk previews it before it saves.
  'scan.postScanTagsBind response': {
    status: 'preview',
    hint: 'A3F9',
    assurance: 'basic',
    scope: 'pass',
    type: { id: TAG_TYPE.id, name: TAG_TYPE.name, use: TAG_TYPE.use },
    bindingId: null,
    card: {
      passId: IDS.pass,
      title: 'Day pass',
      subtitle: 'Ada Example',
      templateName: 'Day pass',
      holderName: 'Ada Example',
      photoUrl: `/api/v1/passes/${IDS.pass}/member-photo/image?v=1`,
    },
    ownerAccount: false,
    opensDefault: 'pass',
    skipped: [],
    warnings: [],
    lostAt: null,
    undoUntil: null,
  },
  'scan.postScanPassesByPassIdNotes request': { body: NOTE.body },
  'scan.postScanPassesByPassIdNotes response': { ...NOTE, at: T.now },
  'scan.getScanPassesByPassIdNotes response': { items: [NOTE], nextCursor: null },
  'scan.postScanRollCall response': {
    ...ROLL_CALL,
    startedAt: T.now,
    rev: 0,
    people: ROLL_CALL.people.map((p) => ({ ...p, mark: null })),
  },
  'scan.postScanRollCallByIdMarks request': {
    marks: [{ rollCallId: IDS.rollCall, passId: IDS.pass, status: 'present', at: T.now - 60_000 }],
  },
  'scan.postScanRollCallByIdEnd response': { ...ROLL_CALL, endedAt: T.now, endedBy: IDS.user },
  'settings.getSettings response': { items: SETTINGS, configRevision: 3 },
  'settings.putSettings request': {
    scope: SCOPE,
    values: { 'org.timeZone': 'America/Los_Angeles' },
    configRevision: 2,
  },
  'settings.putSettings response': {
    items: [{ ...SETTINGS[0], updatedAt: T.now }, SETTINGS[1]],
    configRevision: 3,
  },
  'join-links.putJoinLinksByTemplateId request': {
    enabled: true,
    nameInput: 'name',
    askEmail: true,
    revision: 2,
  },
  // A try token is `pbtry_<payload>.<mac>` (developer/try-token.ts); this one is short, so no scanner takes it.
  'developer.postTryToken response': {
    token: `pbtry_northwind-demo-try.${hex('try-mac', 22)}`,
    expiresAt: T.now + 15 * 60_000,
  },
  'templates.postTemplatesByIdArchive response': {
    ...TEMPLATE_DETAIL,
    status: 'archived',
    updatedAt: T.now,
  },
  'templates.postTemplatesByIdRestore response': {
    ...TEMPLATE_DETAIL,
    status: 'active',
    updatedAt: T.now,
  },
  'templates.postTemplatesByIdClone request': { orgId: IDS.org, name: 'Day pass (kids)' },
  'templates.postTemplatesByIdClone response': {
    ...TEMPLATE_DETAIL,
    id: uuid('template-clone'),
    slug: 'day-pass-kids',
    name: 'Day pass (kids)',
    passCount: 0,
    createdAt: T.now,
    updatedAt: T.now,
    versions: TEMPLATE_DETAIL.versions.map((v) => ({ ...v, createdAt: T.now, passCount: 0 })),
  },
  'templates.putTemplatesByIdManifest request': { manifest: TEMPLATE_VERSION.manifest },
  'templates.postTemplatesByIdVersions request': {
    passJson: TEMPLATE.passJson,
    manifest: TEMPLATE_VERSION.manifest,
    assets: TEMPLATE_VERSION.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
    dryRun: false,
    parentVersion: '3',
  },
  'templates.postTemplatesByIdVersions response': {
    ...TEMPLATE_VERSION,
    saved: true,
    version: '4',
    created: true,
    createdAt: T.now,
    active: false,
    passCount: 0,
  },
  'templates.postTemplatesByIdUseCheck request': {
    orgId: IDS.org,
    name: TEMPLATE.name,
    version: {
      manifest: TEMPLATE_VERSION.manifest,
      assets: TEMPLATE_VERSION.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
    },
    baseVersion: '3',
  },
  'pass-setup.patchOrgsByOrgIdPassSetup response': {
    dryRun: false,
    diff: [{ field: 'brand.accent', before: '#e8b400', after: '#ffc400' }],
  },
  'templates.putTemplatesByIdChannels request': {
    channels: { paper: 'off' },
    revision: 3,
    dryRun: false,
    replaceCodes: false,
  },
  // Paper turned off on the template: the template level now stops it (contracts/channels.ts).
  'templates.putTemplatesByIdChannels response': {
    channels: { mobile: 'on', apple: 'on', google: 'on', samsung: 'on', paper: 'off', nfc: 'on' },
    revision: 4,
    effective: {
      ...CHANNELS.effective,
      paper: { on: false, source: 'template', reason: 'template_off' },
    },
    levels: {
      ...CHANNELS.levels,
      paper: CHANNELS.levels.paper.map((l) =>
        l.level === 'template' ? { ...l, state: 'off', reason: 'template_off' } : l,
      ),
    },
    overrides: {},
    overridePasses: 1,
  },
  'users.postUsersByIdEmails request': { email: 'sam.rivera@example.com' },
  'templates.postTemplatesByIdChannelsResetPasses request': { channels: ['paper'], dryRun: false },
  'templates.postTemplatesByIdChannelsResetPasses response': {
    overrides: { paper: 1 },
    passes: 1,
    done: 1,
    skipped: 0,
    remaining: 0,
  },
  'templates.postTemplatesByIdCandidatesPromote request': {
    mode: 'live',
    provider: 'apple',
    version: '4',
  },
  'me.deleteMeEmailsByEmail response': {
    items: [
      { email: 'ada@example.com', verifiedAt: T.created, verifiedVia: 'magic_link', primary: true },
    ],
    nextCursor: null,
  },
  'org-lifecycle.getOrgsByOrgIdLifecycle response': OPEN,
  'org-lifecycle.postOrgsByOrgIdReopen response': OPEN,
  'org-lifecycle.postOrgsByOrgIdExports response': {
    id: uuid('export-new'),
    state: 'queued',
    createdAt: T.now,
    finishedAt: null,
    expiresAt: null,
    bytes: null,
    entities: null,
    errorCode: null,
  },
  'org-lifecycle.postOrgsByOrgIdExportsByExportIdLink response': {
    url: `https://passbook.mobile/api/v1/orgs/${IDS.org}/exports/${uuid('export')}/download?sig=${hex('export-sig', 16)}`,
    expiresAt: T.now + 15 * 60_000,
  },
  'org-lifecycle.getPlatformClosedOrgs response': {
    items: [
      {
        id: uuid('org-closed'),
        slug: 'harbourside-bouldering',
        name: 'Harbourside Bouldering',
        closedAt: T.created,
        purgeAfter: T.created + 30 * DAY,
        purging: false,
        held: false,
      },
    ],
    nextCursor: null,
  },
  'identities.postIdentitiesByIdRevokeCertificate request': {
    certificateId: uuid('certificate-old'),
    reason: 'compromised',
    confirm: 'pass.mobile.passbook.northwind',
  },
  'identities.postIdentitiesByIdRevokeCertificate response': { ...IDENTITY_RUN, kind: 'revoke' },
  'identities.postIdentitiesByIdRenew response': IDENTITY_RUN,
  'scan.getScanVisitors response': { items: [{ ...VISITOR, note: null }], nextCursor: null },
  'organization-memberships.postOrgsByIdInvitations request': {
    email: INVITATION.email,
    roles: INVITATION.roles,
  },
  'organization-memberships.postOrgsByIdInvitations response': {
    ...INVITATION,
    createdAt: T.now,
    expiresAt: T.now + 7 * DAY,
  },
  'organization-memberships.getOrgsByIdInvitations response': {
    items: [INVITATION],
    nextCursor: null,
  },
  'organization-memberships.postOrgsInvitationsAccept response': membership(
    PRIYA,
    ['pass_operator'],
    T.now,
  ),
  'organization-memberships.getOrgsByIdMemberships response': {
    items: [
      membership(IDS.user, ['org_admin'], T.created),
      membership(PRIYA, ['pass_operator'], T.updated),
    ],
    nextCursor: null,
  },
  'organization-memberships.getOrgsMembershipsMe response': {
    items: [membership(IDS.user, ['org_admin'], T.created)],
    nextCursor: null,
  },
  'metrics.getMetricsOverview response': ORG_METRICS,
  'metrics.getMetricsPlatformOverview response': METRICS,
  'metrics.getMetricsActivity response': ACTIVITY,
  'developer.getHome response': DEVELOPER_HOME,
  'developer.getLogs response': { items: [CALL], nextCursor: null, capped: null },
  'developer.getLog response': CALL,
  'developer.getRail response': {
    mode: 'test',
    scopes: DEVELOPER_HOME.keys[0]?.scopes,
    tier: 'standard',
    limitPerMinute: 60,
    callsLastHour: 11,
    // The same 11 calls in five-minute buckets, oldest first: a burst while the quickstart ran.
    series: spread(11, [0, 0, 1, 0, 0, 2, 3, 1, 0, 0, 1, 1]),
    key: { id: SANDBOX_KEY.id, name: SANDBOX_KEY.name, prefix: 's4Ndb0xK' },
  },
  'developer.postSandbox response': { ...SANDBOX_ROW, key: SANDBOX_KEY, previousKey: null },
  'developer.getSandbox response': { sandbox: SANDBOX_ROW },
  'developer.deleteSandbox response': { ...SANDBOX_ROW, closedAt: T.now },
  'developer.postSandboxReset response': {
    sandbox: SANDBOX_ROW,
    key: NEW_SANDBOX_KEY,
    deleted: { passes: 9, captures: 6, calls: 38, other: 2 },
    kept: 0,
    more: false,
    resetsLeft: 2,
  },
  'developer.postSandboxReopen response': {
    ...SANDBOX_ROW,
    key: NEW_SANDBOX_KEY,
    previousKey: { id: SANDBOX_KEY.id, name: SANDBOX_KEY.name, retireAt: T.now + DAY },
  },
  'wallet-credentials.getOrgsByOrgIdWalletCredentials response': {
    items: [CREDENTIAL],
    nextCursor: null,
  },
  'wallet-credentials.putOrgsByOrgIdWalletCredentials request': {
    provider: 'google',
    expectedRevision: 2,
    credentials: {
      issuerId: '3388000000022843210',
      serviceAccountEmail: 'wallet-issuer@example.com',
    },
  },
  'wallet-credentials.putOrgsByOrgIdWalletCredentials response': {
    ...CREDENTIAL,
    revision: 3,
    verifiedAt: null,
    updatedAt: T.now,
  },
  'wallet-credentials.postOrgsByOrgIdWalletCredentialsByIdRevoke request': { expectedRevision: 2 },
  'wallet-credentials.postOrgsByOrgIdWalletCredentialsByIdRevoke response': {
    ...CREDENTIAL,
    revision: 3,
    revokedAt: T.now,
    updatedAt: T.now,
  },
  'wallet-credentials.postOrgsByOrgIdWalletAccountsGoogleShared response': {
    credential: { ...CREDENTIAL, scope: 'platform', provenance: 'platform' },
    serviceAccountEmail: 'wallet-issuer@example.com',
  },
  'wallet-platform.getPlatformWalletCredentials response': {
    items: [{ ...CREDENTIAL, scope: 'platform', provenance: 'platform' }],
    nextCursor: null,
  },
  'wallet-platform.postPlatformWalletCredentialsByIdRevoke request': { expectedRevision: 2 },
  'wallet-platform.postPlatformWalletCredentialsByIdRevoke response': {
    ...CREDENTIAL,
    scope: 'platform',
    provenance: 'platform',
    revision: 3,
    revokedAt: T.now,
    updatedAt: T.now,
  },
  'wallet-enrolments.getOrgsByOrgIdWalletEnrolments response': {
    items: [ENROLMENT],
    nextCursor: null,
  },
  'wallet-enrolments.putOrgsByOrgIdWalletEnrolmentsByProvider request': {
    source: 'org',
    expectedRevision: 2,
  },
  'wallet-enrolments.putOrgsByOrgIdWalletEnrolmentsByProvider response': {
    ...ENROLMENT,
    enrolmentRevision: 3,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderEnable request': {
    expectedRevision: 2,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderEnable response': {
    ...ENROLMENT,
    state: 'on',
    enrolmentRevision: 3,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderDisable request': {
    expectedRevision: 3,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderDisable response': {
    ...ENROLMENT,
    enrolmentRevision: 4,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderRevoke request': {
    expectedRevision: 4,
  },
  'wallet-enrolments.postOrgsByOrgIdWalletEnrolmentsByProviderRevoke response': {
    ...ENROLMENT,
    state: 'revoked',
    enrolmentRevision: 5,
  },
  'wallet-platform.getPlatformWalletEnrolments response': {
    items: [{ ...ENROLMENT, orgId: IDS.org, orgName: 'Northwind Climbing', updatedAt: T.updated }],
    nextCursor: null,
  },
  'wallet-providers.getWalletProvidersAccounts response': ACCOUNT,
  'wallet-providers.putWalletProvidersAccounts request': {
    orgId: IDS.org,
    mode: 'live',
    provider: 'google',
    expectedRevision: 2,
    credentials: {
      issuerId: '3388000000022843210',
      serviceAccountEmail: 'wallet-issuer@example.com',
    },
  },
  'wallet-providers.putWalletProvidersAccounts response': {
    ...ACCOUNT,
    revision: 3,
    updatedAt: T.now,
  },
  'wallet-providers.postWalletProvidersAccountsVerify response': {
    verified: true,
    verifiedAt: T.now,
    expiresAt: T.now + 30 * DAY,
  },
  'wallet-identities.getPlatformAppleCalls response': {
    items: [
      {
        id: 1042,
        callId: uuid('apple-call'),
        phase: 'provision',
        method: 'POST',
        target: 'certificates',
        caller: 'identity-run',
        status: '201',
        durationMs: 640,
        at: T.created,
      },
    ],
    available: true,
  },
};
