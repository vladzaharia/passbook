// Examples written by hand for the operations people read first. The generator applies them over the sampled ones.
import { CONNECTION_FILE_EXAMPLES } from './example-connection-files.ts';
import {
  API,
  IDS,
  IMPORT_PLAN,
  KEY_PREFIX,
  keySecret,
  MEMBERS_CSV,
  NEW_KEY_PREFIX,
  PASS,
  T,
  TEMPLATE,
} from './example-world.ts';

const INCIDENT = {
  id: IDS.incident,
  title: 'Card scans slow at the front desk',
  note: 'Scans answer in 3 to 5 seconds. Investigating.',
  component: 'api',
  impact: 'degraded',
  startedAt: T.recent,
  resolvedAt: null,
};

const create = {
  templateId: IDS.template,
  input: TEMPLATE.sample,
  holderEmail: 'ada@example.com',
  externalId: 'booking_8841',
  sendEmail: true,
};

const importSource = { kind: 'file', name: 'members.csv', csv: MEMBERS_CSV };

/** `<operationId> <request|response>` to its example. */
export const HEADLINE: Record<string, unknown> = {
  'passes.postPasses request': create,
  'passes.postPasses response': {
    ...PASS,
    createdAt: T.now,
    modifiedAt: T.now,
    deviceCount: 0,
    registrations: 0,
    lastRefreshedAt: null,
    versions: PASS.versions.map((v) => ({ ...v, createdAt: T.now })),
    email: { outcome: 'queued', cap: 'org' },
  },
  'templates.getTemplatesByIdReleasesImpact response': {
    fromVersion: '2',
    toVersion: '3',
    passes: { count: 128, capped: false },
    diff: {
      fields: [
        { label: 'Valid until', kind: 'changed', from: 'Dec 31, 2026', to: 'Mar 31, 2027' },
        { label: 'Visits', kind: 'added', from: null, to: '10' },
      ],
      images: [{ label: 'Logo', kind: 'changed', from: 'logo-v2.png', to: 'logo-v3.png' }],
      barcode: [],
      colors: [{ label: 'Background', kind: 'changed', from: '#0b2545', to: '#112a4a' }],
    },
    more: { fields: 0, images: 0, barcode: 0, colors: 0 },
  },
  'nfc-keysets.postNfcKeysetsByIdImport request': {
    csv: 'uid,type,meta key,file key\n04A3B2C1D5E680,NTAG 424 DNA,00112233445566778899aabbccddeeff,ffeeddccbbaa99887766554433221100\n04A3B2C1D5E681,NTAG 424 DNA,00112233445566778899aabbccddee01,ffeeddccbbaa99887766554433221101\n04A3B2C1D5E682,NTAG 424 DNA,0123456789abcdef0123456789abcdef,ffeeddccbbaa99887766554433221102\n',
    dryRun: true,
  },
  'nfc-keysets.postNfcKeysetsByIdImport response': {
    dryRun: true,
    rows: 3,
    ok: 2,
    added: 0,
    problems: [{ line: 4, uid: '04A3B2C1D5E682', reason: 'weak_key' }],
    moreProblems: 0,
  },
  'status.getStatus response': {
    overall: 'verified',
    // The build deployed two days ago: its id and tag are its UTC date.
    build: { id: '2026-11-23.1', tag: 'v2026.11.23', timestamp: new Date(T.updated).toISOString() },
    components: [
      ['database', 'database', 'Database', 'verified', null],
      ['storage', 'storage', 'File storage', 'verified', null],
      ['queue', 'queue', 'Job queue', 'verified', null],
      ['workflows', 'workflow', 'Workflows', 'verified', null],
      ['identity', 'identity', 'Pass signing identity', 'verified', null],
      ['email', 'email', 'Email', 'configured', 'Sending as hello@example.com'],
      ['oidc', 'oidc', 'Sign-in', 'verified', null],
      ['connections', 'connection', 'Connections', 'not_in_use', null],
      ['cron', 'cron', 'Scheduled jobs', 'verified', 'Last run 2 minutes ago.'],
      ['build', 'build', 'Build', 'verified', null],
    ].map(([id, kind, label, state, detail]) => ({
      id,
      kind,
      label,
      state,
      detail,
      checkedAt: T.recent,
    })),
  },
  'status.getStatusIncidents response': {
    items: [
      { ...INCIDENT, id: IDS.incident },
      {
        id: IDS.incident2,
        title: 'Wallet updates delayed',
        note: 'Apple push was slow for 20 minutes. Back to normal.',
        component: 'apple_push',
        impact: 'notice',
        startedAt: T.created,
        resolvedAt: T.created + 20 * 60_000,
      },
    ],
    nextCursor: null,
  },
  'status.postStatusIncidents request': {
    title: INCIDENT.title,
    note: INCIDENT.note,
    component: 'api',
    impact: 'degraded',
  },
  'status.postStatusIncidents response': { ...INCIDENT, id: IDS.incident },
  'status.postStatusIncidentsByIdResolve response': {
    ...INCIDENT,
    id: IDS.incident,
    note: 'Fixed a slow query. Scans answer in under a second.',
    resolvedAt: T.now,
  },
  'pass-imports.postPassImports request': {
    templateId: IDS.template,
    source: importSource,
    mapping: 'auto',
  },
  ...CONNECTION_FILE_EXAMPLES,
};

/** `<operationId> requests`: named variants shown beside the main request. */
export const HEADLINE_VARIANTS: Record<string, Record<string, unknown>> = {
  'pass-imports.postPassImports': {
    'Auto mapping': { templateId: IDS.template, source: importSource, mapping: 'auto' },
    'Your own mapping': { templateId: IDS.template, source: importSource, plan: IMPORT_PLAN },
  },
};

export const API_BASE = API;

type Obj = Record<string, unknown>;
/** A rotation answers with the new key (new id, prefix and secret) and the old one, now retiring. */
export function rotateAnswer(v: Obj): Obj {
  const key = (v.key ?? {}) as Obj;
  const previous = (v.previous ?? {}) as Obj;
  return {
    ...v,
    key: {
      ...key,
      id: IDS.key2,
      prefix: NEW_KEY_PREFIX,
      secretPrefix: `pb_test_${NEW_KEY_PREFIX}`,
      secret: keySecret(NEW_KEY_PREFIX),
      rotatedFrom: IDS.key,
      lastUsedAt: null,
      createdAt: T.now,
    },
    previous: {
      ...previous,
      id: IDS.key,
      prefix: KEY_PREFIX,
      secretPrefix: `pb_test_${KEY_PREFIX}`,
      // The rotation's overlap: the old secret works for the 24 hours the request asked for.
      retireAt: T.now + 24 * 3_600_000,
    },
  };
}

export const ROTATIONS = new Set([
  'api-keys.postApiKeysByIdRotate',
  'api-keys.postApiKeysMeRotate',
]);
