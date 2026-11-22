// Examples written by hand for the operations people read first. The generator applies them over the sampled ones.
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
  'passes.postPasses response': { ...PASS, email: { outcome: 'queued', cap: 'org' } },
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
  'pass-imports.postPassImports request': {
    templateId: IDS.template,
    source: importSource,
    mapping: 'auto',
  },
};

/** `<operationId> requests`: named variants shown beside the main request. */
export const HEADLINE_VARIANTS: Record<string, Record<string, unknown>> = {
  'pass-imports.postPassImports': {
    'Auto mapping': { templateId: IDS.template, source: importSource, mapping: 'auto' },
    'Your own mapping': { templateId: IDS.template, source: importSource, plan: IMPORT_PLAN },
  },
};

export const API_BASE = API;

const admit = { id: 'admit', label: 'Admit', kind: 'check_in' };
// biome-ignore lint/suspicious/noExplicitAny: a sampled answer is untyped JSON
type Json = Record<string, any>;

/** Fixes a sampled scan answer so its parts agree: a pass that is fine, admitted at the desk. */
export function scanAnswer(v: Json): Json {
  const card = (v.card ?? {}) as Json;
  return {
    ...v,
    scanId: IDS.scan,
    kind: 'ok',
    reason: null,
    action: admit,
    flags: [],
    card: {
      ...card,
      passId: IDS.pass,
      title: 'Day pass',
      subtitle: 'Ada Example',
      flags: [],
      values: [],
      actions: [{ ...(card.actions?.[0] ?? {}), ...admit }],
    },
  };
}

export const SCAN_ANSWERS = new Set([
  'scan.postScanResolve',
  'scan.postScanActions',
  'scan.postScanScansByScanIdUndo',
]);

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
      retireAt: T.later,
    },
  };
}

export const ROTATIONS = new Set([
  'api-keys.postApiKeysByIdRotate',
  'api-keys.postApiKeysMeRotate',
]);
