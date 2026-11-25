// Builds an example from a schema and the fictional world (example-world.ts): values by field name, then format.

import { SHAPES } from './example-canon.ts';
import { ERROR_KEYS, errorCodeFor, fieldValue, OMIT, stateTimeKey } from './example-fields.ts';
import { humanName } from './example-names.ts';
import { PROSE_KEYS } from './example-text.ts';
import {
  API,
  hex,
  IDS,
  KEY_PREFIX,
  KIND_OF_TAG,
  keySecret,
  NAMES,
  ORG,
  ORG_SLUG,
  PASS,
  pem,
  SITE,
  T,
  TEMPLATE,
  TEXT,
  webhookSecret,
} from './example-world.ts';

// biome-ignore lint/suspicious/noExplicitAny: schemas and samples are untyped JSON
type Json = Record<string, any>;
export interface Ctx {
  doc: Json;
  /** The kind of resource the operation is about. */
  kind: string;
  op: string;
  request: boolean;
  /** Keys with no rule, for the generator to report. */
  unknown: Set<string>;
}

const refName = (r: string): string => r.slice(r.lastIndexOf('/') + 1);
function resolve(ctx: Ctx, s: Json | undefined): Json {
  let cur: Json = s ?? {};
  for (let i = 0; i < 20 && cur.$ref; i++)
    cur = ctx.doc.components.schemas[refName(cur.$ref)] ?? {};
  return cur;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const typesOf = (ctx: Ctx, s: Json): string[] => {
  const alts: Json[] = s.oneOf ?? s.anyOf ?? [];
  if (alts.length) return alts.flatMap((a) => typesOf(ctx, resolve(ctx, a)));
  if (s.const !== undefined) return [s.const === null ? 'null' : typeof s.const];
  return Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
};
function allowsNull(ctx: Ctx, s: Json): boolean {
  return typesOf(ctx, s).includes('null') || (Array.isArray(s.enum) && s.enum.includes(null));
}
/** A scalar fits a schema when its type, enum, const, pattern and bounds allow it. */
function fits(ctx: Ctx, s: Json, v: unknown): boolean {
  const alts: Json[] = s.oneOf ?? s.anyOf ?? [];
  if (alts.length) return alts.some((a) => fits(ctx, resolve(ctx, a), v));
  if (s.const !== undefined) return s.const === v;
  if (Array.isArray(s.enum)) return s.enum.includes(v);
  const types = typesOf(ctx, s);
  const t = typeof v === 'number' && Number.isInteger(v) ? ['integer', 'number'] : [typeof v];
  if (types.length && !t.some((x) => types.includes(x))) return false;
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) return false;
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) return false;
    if (typeof s.minLength === 'number' && v.length < s.minLength) return false;
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) return false;
    if (typeof s.maximum === 'number' && v > s.maximum) return false;
  }
  return true;
}
/** The alternative of a union that a seed object belongs to: it has the seed's keys and its fixed values. */
function shapeFits(ctx: Ctx, s: Json, seed: Json): boolean {
  const props: Json = s.properties ?? {};
  return Object.entries(seed).every(([k, v]) => {
    const p = props[k] ? resolve(ctx, props[k]) : undefined;
    if (!p) return s.additionalProperties !== false && !s.properties;
    return p.const === undefined && !p.enum ? true : fits(ctx, p, v);
  });
}

const KIND_KEYS: Record<string, string> = {
  org: 'org',
  template: 'template',
  pass: 'pass',
  holder: 'holder',
  identity: 'identity',
  scanner: 'scanner',
  keyset: 'keyset',
  connection: 'connection',
  endpoint: 'endpoint',
  webhook: 'endpoint',
  import: 'import',
  zone: 'zone',
  session: 'session',
  device: 'device',
  staff: 'staff',
  bundle: 'bundle',
  broadcast: 'broadcast',
  rule: 'rule',
  visitor: 'visitor',
  rollCall: 'rollCall',
  tag: 'tag',
  candidate: 'candidate',
  release: 'release',
  run: 'run',
  delivery: 'delivery',
  scan: 'scan',
  print: 'print',
  job: 'job',
  event: 'event',
  key: 'key',
  apiKey: 'key',
  user: 'user',
  member: 'user',
  owner: 'user',
  actor: 'user',
  host: 'user',
  createdBy: 'user',
  updatedBy: 'user',
  startedBy: 'user',
  endedBy: 'user',
  requestedBy: 'user',
  action: 'action',
  defaultAction: 'action',
  serial: 'serial',
  serialNumber: 'serial',
};

/** A name for a field that is not a person. */
function nameFor(key: string, kind: string, path = ''): string {
  if (/^(org|organization)Name$/.test(key)) return ORG;
  if (/template/i.test(key)) return NAMES.template as string;
  if (/scanner|device/i.test(key))
    return /device/i.test(key) ? (NAMES.device as string) : (NAMES.scanner as string);
  if (/event/i.test(key)) return NAMES.event as string;
  if (/zone|place/i.test(key)) return NAMES.zone as string;
  if (/key/i.test(key)) return NAMES.key as string;
  // Only the template is called "Day pass"; everything else takes its name from the world.
  if (/\.type\b|tagType/i.test(path)) return 'Wristband';
  if (/sandbox/i.test(path)) return 'Northwind sandbox';
  if (/user|session|member|owner/i.test(path)) return NAMES.user as string;
  return (NAMES[kind] as string) ?? (kind === 'row' ? ORG : 'Day pass');
}

/** The string for a field, or undefined when no rule applies. */
function stringFor(key: string, kind: string, ctx: Ctx): string | undefined {
  const k = key;
  const rules: [RegExp, string | (() => string)][] = [
    [
      /^slug$/,
      () =>
        kind === 'org'
          ? ORG_SLUG
          : kind === 'template'
            ? TEMPLATE.slug
            : kind === 'keyset'
              ? 'gym-doors-2026'
              : kind === 'zone'
                ? 'main-hall'
                : `${nameFor(k, kind)
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')}`,
    ],
    [/^confirmSlug$/, ORG_SLUG],
    // A roster entry's pass ordinal within one response.
    [/^g$/, '1'],
    [
      /^(version|templateVersion|activeVersion|baseVersion|fromVersion|toVersion|appVersion)$/,
      () => (k === 'appVersion' ? '1.4.2' : TEXT.version),
    ],
    [/^timeZone$|^effectiveTimeZone$/, TEXT.timeZone],
    [/^locale$/, TEXT.locale],
    [/^currency$/, 'USD'],
    [/^(sha|sha1)$/, () => hex(`${ctx.op}${k}`, 40)],
    [
      /^(candidateHash|contentHash|sourceReleaseHash|providerIdentityHash|hash)$/,
      () => hex(`${ctx.op}${k}`, 64),
    ],
    [
      /^(secret|webhookSecret|newSecret)$/,
      () => (ctx.kind === 'key' ? keySecret(KEY_PREFIX) : webhookSecret(`${ctx.op}${k}`)),
    ],
    [/^secretPrefix$/, () => (ctx.kind === 'endpoint' ? 'whsec_demo' : `pb_test_${KEY_PREFIX}`)],
    [/^prefix$/, () => (ctx.kind === 'endpoint' ? 'whsec_demo' : KEY_PREFIX)],
    [
      /^(token|apiKey|rawKey)$/,
      () => (/Try/.test(ctx.op) ? keySecret(KEY_PREFIX) : 'c0ffee00c0ffee00c0ffee00c0ffee01'),
    ],
    [/^(privateKeyPem|keyPem|pem)$/, pem('PRIVATE KEY')],
    [/^(certificatePem|publicKeyPem)$/, pem('CERTIFICATE')],
    [/^(voidCause|refused|refusedReason)$/, () => (k === 'voidCause' ? 'refund' : 'expired')],
    [/^subject$/, 'Your Northwind Climbing pass'],
    [
      /^(title|alt|actionLabel|label|rewardLabel|pairedLabel|typeName|placeNames|description|group|icon|style)$/,
      () =>
        k === 'description'
          ? kind === 'endpoint'
            ? 'Booking system events'
            : kind === 'org'
              ? 'A climbing gym in Seattle.'
              : TEMPLATE.description
          : k === 'title'
            ? 'Day pass'
            : k === 'icon'
              ? 'ticket'
              : k === 'style'
                ? 'generic'
                : k === 'group'
                  ? 'Access'
                  : k === 'rewardLabel'
                    ? 'Free day pass'
                    : k === 'pairedLabel'
                      ? 'Front desk tablet'
                      : k === 'actionLabel'
                        ? 'Admit'
                        : k === 'typeName'
                          ? 'Wristband'
                          : k === 'alt'
                            ? 'Northwind logo'
                            : nameFor(k, kind),
    ],
    [/^(downloadUrl)$/, () => PASS.downloadUrl],
    [/^(publicUrl|url|link|joinUrl|pageUrl)$/, () => PASS.publicUrl],
    [/^(supportUrl|helpUrl)$/, `${SITE}/help`],
    [/^(webhookUrl|endpointUrl)$/, 'https://hooks.example.com/passbook'],
    [/^assetBaseUrl$/, () => `${API}/assets/${IDS.pass}/`],
    [
      /^(device|host|via|source|origin)$/,
      () =>
        k === 'origin'
          ? 'uploaded'
          : k === 'via'
            ? 'api'
            : k === 'source'
              ? 'api'
              : k === 'host'
                ? 'host'
                : 'iPhone 15',
    ],
    [
      /^(connectorType|type|plan|step|variant|slot|actorType|enum|preset|flags|value|values|key|ref|externalRef|runId|pointer|path|field|column|target|q|to|from|end|sendAt|date|eventRef|missing|promotable|assetGrant|waitingFor|identityHint|png|csv|meta|samples|refusedReason|alt)$/,
      () => 'x',
    ],
  ];
  for (const [re, v] of rules) if (re.test(k)) return typeof v === 'function' ? v() : v;
  return undefined;
}

/** Field-specific strings the first table leaves to context. */
function contextString(key: string, kind: string, path: string, ctx: Ctx): string | undefined {
  switch (key) {
    case 'url':
      return kind === 'endpoint' ? 'https://hooks.example.com/passbook' : undefined;
    case 'holderEmailField':
      return '/Holder email';
    case 'connectorType':
      return 'google-sheets';
    case 'type':
      return /event/i.test(ctx.op) ? 'pass.issued' : /scan/i.test(path) ? 'scan' : 'generic';
    case 'plan':
      return 'Day pass';
    case 'step':
      return 'mapping';
    case 'variant':
      return 'default';
    case 'slot':
      return 'logo';
    case 'actorType':
      return 'api_key';
    case 'preset':
      return 'standard';
    case 'flags':
      return 'urgent';
    case 'value':
      return /voidWhen/.test(path) ? 'Refunded' : 'Day pass';
    case 'values':
      return /voidWhen/.test(path) ? 'Refunded' : 'Day pass';
    case 'key':
      return 'tier';
    case 'ref':
    case 'externalRef':
      return 'booking_8841';
    case 'runId':
      return 'bulk-0193a1b2-7c00-7000-8000-000000000023';
    case 'pointer':
      return '/input/tier';
    case 'path':
      return 'input.tier';
    case 'field':
    case 'column':
      return 'tier';
    case 'target':
      return 'tier';
    case 'q':
      return 'ada';
    case 'to':
      return 'ada@example.com';
    case 'from':
      return /voidWhen/.test(path)
        ? 'Tier'
        : /email|rule|broadcast/i.test(ctx.op)
          ? 'hello@example.com'
          : 'Booking sheet';
    case 'end':
      return '2026-12-31';
    case 'sendAt':
      return '2026-12-24T09:00:00.000Z';
    case 'date':
      return '2026-12-24';
    case 'eventRef':
      return 'event:open-climbing';
    case 'missing':
      return 'validUntil';
    case 'promotable':
      return 'yes';
    case 'assetGrant':
      return 'logo';
    case 'waitingFor':
      return 'approval';
    case 'identityHint':
      return 'Northwind signing identity';
    case 'png':
      return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    case 'csv':
      return 'name,email,tier\nAda Example,ada@example.com,Day pass\n';
    case 'meta':
      return 'Northwind';
    case 'samples':
    case 'sample':
      return 'Day pass';
    case 'actorLabel':
    case 'approvedBy':
    case 'by':
    case 'staff':
    case 'undoneBy':
      return 'Sam Rivera';
    case 'code':
      return 'NW7K2Q';
    case 'enum':
      return 'adult';
    case 'expectedRevision':
      return '4';
    case 'holder':
      return 'Ada Example';
    case 'identifier':
    case 'sharedIdentifier':
      return 'pass.mobile.passbook.northwind';
    case 'initials':
      return 'AE';
    case 'input':
      return 'tier';
    case 'ipAllow':
      return '203.0.113.0/24';
    case 'keys':
      return 'booking_8841';
    case 'nextCursor':
    case 'cursor':
      return 'c1.4812';
    case 'passTitle':
    case 'preview':
    case 'tier':
      return 'Day pass';
    case 'releaseBlocked':
      return 'no_release';
    case 'sheetsToken':
      return '••••3f9c';
    case 'types':
    case 'type_':
      return 'wristband';
    case 'keyId':
      return 'A1B2C3D4E5';
    case 'uid':
      return '04A3B2C1D5E680';
    case 'undoes':
      return `0193a1b2-7c00-7000-8000-${hex(`${ctx.op}undoes`, 12)}`;
    case 'urlMasked':
      return 'https://hooks.example.com/…';
    case 'assetName':
      return 'logo.png';
    case 'adapterCapability':
      return 'read';
    case 'alias':
      return 'daypass';
    case 'reason':
      return /Apns/.test(ctx.op) ? 'BadDeviceToken' : undefined;
    case 'actionId':
    case 'defaultActionId':
      return 'admit';
    case 'idempotencyKey':
      return IDS.idem;
    default:
      return FIELD[key]?.(ctx, path);
  }
}

/** Free-text fields with no sentence for their family; the generator fails with this list. */
export const unwritten = new Set<string>();

/** A name field: a person in person fields, a resource name elsewhere. */
function nameField(key: string, path: string, op: string): string | undefined {
  if (!/[nN]ame$|^name$|^label$|^title$|^subtitle$/.test(key)) return undefined;
  // The holder of a pass is Ada (or a visitor); the people who work at the gym are its staff.
  if (/holder|owner|subtitle/i.test(key)) return 'Ada Example';
  if (/^visitor/i.test(key)) return 'Jordan Lee';
  if (
    /holder|member|owner|host|visitor|staff|admin|author|reviewer|createdBy|startedBy|endedBy|requestedBy/i.test(
      key + path,
    )
  )
    return key === 'subtitle' ? 'Ada Example' : 'Sam Rivera';
  if (/^subtitle$/.test(key)) return 'Ada Example';
  if (/^(ownerName)$/.test(key)) return 'Ada Example';
  return humanName(key, path, op);
}

const PREFER = [
  'healthy',
  'active',
  'ok',
  'done',
  'succeeded',
  'success',
  'completed',
  'complete',
  'finished',
  'sent',
  'delivered',
  'paired',
  'ready',
  'live',
  'standard',
];
/** States that say a thing has not happened yet; an everyday example is past them. */
const UNSETTLED =
  /^(pending|running|queued|claimed|scheduled|draft|not_paired|unknown|none|retry|blocked|absent)$/;
function pickEnum(values: unknown[], key: string): unknown {
  if (values.includes(null) && /^(reason|milestone|turnaround)$/.test(key)) return null;
  if (values.includes('')) return '';
  if (key === 'screen') return 'ok';
  const settled = values.find((x) => typeof x === 'string' && !UNSETTLED.test(x));
  return (
    PREFER.find((p) => values.includes(p)) ?? settled ?? values.find((x) => x !== null) ?? values[0]
  );
}

/** Fields that describe a resource gone wrong or retired; an everyday example leaves them empty. */
const STATE_KEYS =
  /^(endCause|endedAt|waitingFor|revokedAt|retireAt|retiredAt|removedAt|disabledAt|deletedAt|archivedAt|failingSince|rotatedFrom|parentKeyId|previous\w*|breakerOpenUntil|undoUntil|lastError\w*|syncErrorCode|errorDetail|errorCode|errorFile|voidedAt|expiredAt|matched|pushBudget|blocked\w*|pairedAt|pairedBy\w*|lastStatus|closedAt|closingAt|hold)$/;

type Maker = (ctx: Ctx, path: string) => string;
const h =
  (n: number): Maker =>
  (ctx, path) =>
    hex(`${ctx.op}${path}`, n);
const t =
  (v: string): Maker =>
  () =>
    v;
const id12: Maker = (ctx, path) => `0193a1b2-7c00-7000-8000-${hex(`${ctx.op}${path}`, 12)}`;
/** Plain strings with no better rule: a real value for each field, never the field's name. */
const FIELD: Record<string, Maker> = {
  turnstileToken: t('0.demo-turnstile-response-northwind'),
  turnstileSiteKey: t('0x4AAAAAAAdemoNorthwind'),
  csrfToken: t('csrf_demo_northwind'),
  next: t('/account'),
  removalMessage: t('Removed by the front desk.'),
  href: t(PASS.publicUrl),
  userAgent: t('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'),
  method: t('GET'),
  route: t('/api/v1/passes'),
  query: t('limit=25'),
  client: t('PassBook SDK for TypeScript'),
  requestBody: t('{"limit":25}'),
  responseBody: t('{"items":[],"nextCursor":null}'),
  orgSlug: t(ORG_SLUG),
  confirm: t(ORG_SLUG),
  nameInput: t(ORG),
  revision: t('4'),
  x2: t('logo@2x.png'),
  x3: t('logo@3x.png'),
  passLabel: t('Day pass'),
  placedByLabel: t('Sam Rivera'),
  releasedByLabel: t('Sam Rivera'),
  cls: t('ok'),
  mac: h(64),
  prevMac: h(64),
  refsDigest: h(64),
  certSha256: h(64),
  sig: h(64),
  presetLabel: t('Standard'),
  parentVersion: t('2'),
  releaseVersion: t('3'),
  html: t('<p>Your Northwind pass is ready.</p>'),
  passTypeIdentifier: t('pass.mobile.passbook.northwind'),
  teamIdentifier: t('A1B2C3D4E5'),
  certSubject: t('CN=Pass Type ID: pass.mobile.passbook.northwind'),
  certSerial: h(16),
  apnsBinding: t('production'),
  apnsReason: t('BadDeviceToken'),
  handle: t('northwind'),
  pkcs12Base64: t('MIIKcQIBAzCCCjcGCSqGSIb3DQEHAaCC…'),
  p8: t(pem('PRIVATE KEY')),
  phase: t('active'),
  caller: t('terminal'),
  status: t('ok'),
  provider: t('google'),
  action: t('issue'),
  lastIpPrefix: t('203.0.113'),
  ipPrefix: t('203.0.113'),
  targetType: t('pass'),
  issuer: t('https://id.example.com'),
  platformAdminGroup: t('passbook-admins'),
  adminGroup: t('northwind-admins'),
  developerGroup: t('northwind-developers'),
  userGroup: t('northwind-staff'),
  address: t('ada@example.com'),
  targetLabel: t('Day pass'),
  tag: t('wristband-14'),
  timestamp: t(new Date(T.recent).toISOString()),
  unavailable: t('not_configured'),
  host: t('passbook.mobile'),
  overrideOf: id12,
  replaces: id12,
  skipped: t('no_email'),
  place: t('zone:main-hall'),
  door: t('in'),
  where: t('passes'),
  headline: t('Day pass'),
  sub: t('Ada Example'),
  greet: t('Hi Ada'),
  eventType: t('pass.issued'),
  flag: t('vip'),
  log: t('Delivered to the endpoint; it answered 200.'),
};

const TRUE_KEYS = /^(is|has|can|allow|enabled|active|ok|sendEmail|valid|live|default)/;

/**
 * A value for `schema`. `seed` is the world's own value for this place (a canonical object, a hand-written part): it
 * wins wherever it fits the schema, and the schema fills in what it leaves out, so a seed never breaks validity.
 */
export function sample(
  ctx: Ctx,
  schema: Json | undefined,
  key: string,
  path: string,
  kind: string,
  depth: number,
  seed?: unknown,
): unknown {
  const s = resolve(ctx, schema);
  if (seed === null && allowsNull(ctx, s)) return null;
  if (seed !== undefined && seed !== null && typeof seed !== 'object' && fits(ctx, s, seed))
    return seed;
  const fixed = seed === undefined ? fieldValue(ctx, key, path) : undefined;
  // A rule may give a whole object or list: it seeds this place like a canonical value.
  if (fixed && typeof fixed === 'object') return sample(ctx, schema, key, path, kind, depth, fixed);
  if (fixed !== undefined && fixed !== OMIT) {
    if (fixed === null ? allowsNull(ctx, s) : fits(ctx, s, fixed)) return fixed;
    // An error code the schema requires: the record failed, with a code its operation can carry.
    if (fixed === null && ERROR_KEYS.test(key) && typesOf(ctx, s).includes('string'))
      return errorCodeFor(ctx.doc, ctx.op);
  }
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (s.enum) return pickEnum(s.enum, key);
  const alts = s.oneOf ?? s.anyOf;
  if (alts) {
    const non = alts.filter((a: Json) => resolve(ctx, a).type !== 'null');
    const like = isObj(seed)
      ? non.find((a: Json) => shapeFits(ctx, resolve(ctx, a), seed))
      : undefined;
    return sample(ctx, like ?? non[0] ?? alts[0], key, path, kind, depth, seed);
  }
  if (s.allOf) {
    const named = s.allOf.find((a: Json) => a.$ref);
    if (named) return sample(ctx, named, key, path, kind, depth, seed);
  }
  if (seed !== undefined && !s.type && !s.properties && !s.items) return seed;
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t: string) => t !== 'null') ?? type[0];
  if (!type && s.properties) type = 'object';
  // A nested object that is not a known resource is its own row, never the parent's resource.
  // An object's own `id` names the object: the kind it was sampled as, so one entity keeps one id everywhere.
  const subKind =
    key === 'id'
      ? kind
      : (KIND_KEYS[key.replace(/Id$/, '')] ?? (/^(body|items|)$/.test(key) ? kind : 'row'));
  switch (type) {
    case 'string':
      return str(ctx, s, key, path, subKind);
    case 'integer':
    case 'number':
      return num(s, key);
    case 'boolean':
      return TRUE_KEYS.test(key);
    case 'null':
      return null;
    case 'array': {
      if (depth > 8) return [];
      const seeds = Array.isArray(seed) ? seed : undefined;
      if (s.prefixItems)
        return s.prefixItems.map((it: Json, i: number) =>
          sample(ctx, it, key, `${path}[${i}]`, subKind, depth + 1, seeds?.[i]),
        );
      const n = seeds ? Math.max(seeds.length, s.minItems ?? 0) : Math.max(1, s.minItems ?? 1);
      const item =
        key === 'aliases'
          ? 'alias'
          : key
              .replace(/Ids$/, 'Id')
              .replace(/ities$/, 'ity')
              .replace(/(?<!s)s$/, '');
      return Array.from({ length: seeds ? Math.min(n, s.maxItems ?? n) : Math.min(n, 2) }, (_, i) =>
        sample(
          ctx,
          s.items,
          item,
          `${path}[${i}]`,
          KIND_KEYS[item] ?? subKind,
          depth + 1,
          seeds?.[i],
        ),
      );
    }
    case 'object':
      return object(ctx, s, key, path, subKind, depth, isObj(seed) ? seed : undefined);
    default:
      // A field with no declared type holds a value: the template input it names, a setting's value, or nothing.
      return key === 'detail'
        ? { externalId: 'booking_8841' }
        : key in TEMPLATE.sample
          ? TEMPLATE.sample[key as keyof typeof TEMPLATE.sample]
          : /^(value|default)$/.test(key)
            ? 'standard'
            : null;
  }
}

function object(
  ctx: Ctx,
  s: Json,
  key: string,
  path: string,
  kind: string,
  depth: number,
  seed?: Json,
): unknown {
  if (seed && !s.properties) {
    // A map: the seed's keys, each value fitted to the map's value schema.
    const extra = s.additionalProperties;
    return Object.fromEntries(
      Object.entries(seed).map(([k, v]) => [
        k,
        extra && typeof extra === 'object'
          ? sample(ctx, extra, k, `${path}.${k}`, kind, depth + 1, v)
          : v,
      ]),
    );
  }
  if (key === 'passJson') return TEMPLATE.passJson;
  if (key === 'overrides' && s.additionalProperties?.additionalProperties)
    return { Plan: { Annual: 'Day pass' } };
  if (/^(personalization|input|sample)$/.test(key) && !s.properties) return TEMPLATE.sample;
  if (key === 'fieldSources') return TEMPLATE.fieldSources;
  if (key === 'config' && !s.properties)
    return { sheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', range: 'Members!A:E' };
  if (key === 'mapping' && !s.properties && s.additionalProperties)
    return { name: { from: 'Name' }, tier: { from: 'Tier' }, validUntil: { from: 'Valid until' } };
  const props: Json = s.properties ?? {};
  const out: Json = {};
  const canon =
    seed ?? (ctx.request ? {} : (SHAPES.find((c) => c.has.every((k) => k in props))?.value ?? {}));
  const required: string[] = s.required ?? [];
  // A row whose `id` would equal one of its own foreign keys (a release holds `templateId`) is its own kind.
  const foreign = new Set(
    Object.keys(props)
      .filter((k) => k.endsWith('Id'))
      .map((k) => KIND_KEYS[k.slice(0, -2)]),
  );
  const idKind = foreign.has(kind) ? ownKindOf(ctx.op) : kind;
  let optional = 0;
  const cap = ctx.request ? (depth === 0 ? 3 : 2) : 14;
  for (const [k, v] of Object.entries<Json>(props)) {
    if (!(k in canon) && !required.includes(k) && fieldValue(ctx, k, `${path}.${k}`) === OMIT)
      continue;
    if (!(k in canon) && STATE_KEYS.test(k)) {
      // A state an ordinary example is not in: null where the field allows it, else absent.
      const nullable = Array.isArray(v.type) && v.type.includes('null');
      if (nullable) {
        out[k] = !ctx.request && depth <= 1 && stateTimeKey(ctx.op)?.test(k) ? T.now : null;
        continue;
      }
      if (!required.includes(k)) continue;
    }
    // A seed or canonical object says which optional fields the record has; an empty seed has none.
    if (!required.includes(k) && !(k in canon) && (seed || Object.keys(canon).length)) continue;
    if (!required.includes(k) && !(k in canon)) {
      if (v.deprecated || optional >= cap || depth > 8) continue;
      optional++;
    }
    const value = sample(
      ctx,
      v,
      k,
      `${path}.${k}`,
      k === 'id' ? idKind : kind,
      depth + 1,
      k in canon ? canon[k] : undefined,
    );
    // The record a state change answers with carries the time of that change (archive -> archivedAt).
    if (value === null && !ctx.request && depth <= 1 && stateTimeKey(ctx.op)?.test(k))
      out[k] = T.now;
    else if (value !== undefined) out[k] = value;
  }
  // A canonical object is coherent as written; only sampled rows need their fields reconciled.
  if (!Object.keys(canon).length) fixState(out, props, ctx);
  if (!Object.keys(props).length) {
    const extra = s.additionalProperties;
    const mapKey =
      key === 'secrets'
        ? 'sheetsToken'
        : /^(config|mapping)$/.test(key)
          ? 'sheetId'
          : /hours|dates/.test(key)
            ? '2026-12-24'
            : /counts|byHealth|patch/.test(key)
              ? 'healthy'
              : /params/.test(key)
                ? 'field'
                : 'tier';
    if (extra && typeof extra === 'object')
      out[mapKey] = sample(ctx, extra, mapKey, `${path}.${mapKey}`, kind, depth + 1);
  }
  return out;
}

function str(ctx: Ctx, s: Json, key: string, path: string, kind: string): string {
  const f = s.format;
  if (s.pattern?.startsWith('^#[0-9a-fA-F]{6}'))
    return /label/i.test(key)
      ? '#ffc400'
      : /foreground/i.test(path)
        ? '#ffffff'
        : /accent/i.test(path)
          ? '#ffc400'
          : '#112a4a';
  if (key === 'actionId' || key === 'defaultActionId' || key === 'idempotencyKey')
    return contextString(key, kind, path, ctx) as string;
  if (f === 'date-time')
    return new Date(
      /Until|After|expires|due|Before/.test(key) ? T.validUntil : T.recent,
    ).toISOString();
  if (f === 'date') return '2026-12-01';
  if (key === 'externalId') return 'booking_8841';
  if (/Field$/.test(key)) return contextString(key, kind, path, ctx) ?? '/Holder email';
  if (f === 'email' || /email/i.test(key))
    return /host|staff|admin/i.test(key) ||
      (/user|owner|member/i.test(path) && !/holder/i.test(path))
      ? 'sam@example.com'
      : /support|help/i.test(key)
        ? 'help@example.com'
        : 'ada@example.com';
  if (f === 'uri' || f === 'url') return PASS.publicUrl;
  const uuidPattern =
    (!s.pattern || s.pattern.startsWith('^[0-9a-fA-F]{8}-')) && (!s.maxLength || s.maxLength >= 36);
  if (
    uuidPattern &&
    (f === 'uuid' ||
      /^id$|Id$|^serial$|^serialNumber$|^(createdBy|updatedBy|startedBy|endedBy|requestedBy)$/.test(
        key,
      ))
  ) {
    const base = key.replace(/Id$/, '');
    const k =
      KIND_KEYS[base] ??
      KIND_KEYS[base.replace(/^.*(?=[A-Z])/, '').replace(/^./, (c) => c.toLowerCase())] ??
      (/^id$/.test(key) ? kind : undefined);
    // A source, previous or parent id names another row of the same kind, never this one.
    const hit =
      k && !/^(source|previous|parent|prior|original|base|undoes)/.test(key) ? IDS[k] : undefined;
    return hit ?? `0193a1b2-7c00-7000-8000-${hex(`${ctx.op}${path}`, 12)}`;
  }
  const name = nameField(key, path, ctx.op);
  if (name) return name;
  if (PROSE_KEYS.test(key)) {
    // Free text comes from its family's sentences (example-text.ts) or not at all.
    unwritten.add(`${key} at ${path} of ${ctx.op}`);
    return 'MISSING';
  }
  let v = contextString(key, kind, path, ctx) ?? stringFor(key, kind, ctx);
  if (v === 'x') v = undefined;
  if (v === undefined) {
    if (s.pattern?.startsWith('^#[0-9a-fA-F]{6}'))
      v = /^(foreground|label)/.test(key) ? '#ffffff' : /accent/.test(key) ? '#ffc400' : '#112a4a';
    else if (s.pattern) v = byPattern(s.pattern, `${ctx.op}${path}`);
    else if (/color|colour/i.test(key))
      v = key.startsWith('foreground')
        ? '#ffffff'
        : key.startsWith('label')
          ? '#ffc400'
          : '#112a4a';
    else if (/(Url|Uri)$/.test(key)) v = PASS.publicUrl;
    else {
      ctx.unknown.add(key);
      v = key;
    }
  }
  if (v === undefined) {
    ctx.unknown.add(`${key} (pattern ${s.pattern})`);
    v = key;
  }
  if (s.pattern && !new RegExp(s.pattern).test(v))
    v = byPattern(s.pattern, `${ctx.op}${path}`) ?? v;
  if (typeof s.minLength === 'number') while (v.length < s.minLength) v += ' ok';
  if (typeof s.maxLength === 'number' && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

/** 32 hex digits; the two NFC keys are plainly sequential, so no scanner takes them for key material. */
const hex32 = (seed: string): string =>
  seed.endsWith('metaKey')
    ? '00112233445566778899aabbccddeeff'
    : seed.endsWith('fileKey')
      ? 'ffeeddccbbaa99887766554433221100'
      : /[tT]oken$/.test(seed)
        ? 'c0ffee00c0ffee00c0ffee00c0ffee01'
        : hex(seed, 32);

const PATTERNS: [string, (seed: string) => string][] = [
  ['^([01]\\d|2[0-3]):[0-5]\\d-(([01]\\d|2[0-3]):[0-5]\\d|24:00)$', () => '09:00-21:00'],
  ['^(zone|event):\\S{1,64}$', () => 'zone:main-hall'],
  ['^[0-9A-F]{4}$', (s) => hex(s, 4).toUpperCase()],
  ['^[0-9a-f]{40}$', (s) => hex(s, 40)],
  ['^[0-9a-f]{64}$', (s) => hex(s, 64)],
  ['^[0-9a-f]{8}$', (s) => hex(s, 8)],
  ['^[a-z0-9]{8}$', (s) => hex(s, 8)],
  ['^[0-9a-fA-F]{32}$', (s) => hex32(s)],
  ['^([01]\\d|2[0-3]):[0-5]\\d$', () => '04:00'],
  ['^[0-9]{1,32}$', () => '3388000000022843210'],
  ['^[A-Za-z0-9_-]{43}$', (s) => `demo-token-northwind-${hex(s, 22)}`],
  ['^[0-9a-f]{32}$', (s) => hex32(s)],
  ['^\\d{6}$', (s) => String(100000 + (parseInt(hex(s, 5), 16) % 899999))],
];
function byPattern(pattern: string, seed: string): string | undefined {
  const hit = PATTERNS.find(([p]) => p === pattern);
  if (hit) return hit[1](seed);
  const re = new RegExp(pattern);
  return [
    'northwind',
    'day-pass',
    'main-hall',
    'gym-doors-2026',
    'ada@example.com',
    '2026-12-01',
    'en-US',
    'USD',
    '+14155550123',
    'America/Los_Angeles',
  ].find((c) => re.test(c));
}

function num(s: Json, key: string): number {
  let v = 2 + (Number.parseInt(hex(key, 4), 16) % 38);
  if (key === 'clearAfter') v = 7 * 86_400_000;
  else if (key === 'asOf') v = T.recent;
  else if (/^(from|start)$/.test(key)) v = T.now - 24 * 3_600_000;
  else if (/^(to|end)$/.test(key)) v = T.now;
  else if (key === 'until') v = T.soon;
  else if (/validFrom$|^windowFrom$|From$/.test(key)) v = T.validFrom;
  else if (/validUntil$|Until$|After$|^notAfter$|expiresAt$|^expires/.test(key))
    v = /breaker/.test(key) ? T.soon : /undo/.test(key) ? T.soon : T.validUntil;
  else if (/^(createdAt|startedAt|firstSeenAt|notBefore)$/.test(key)) v = T.created;
  else if (/^(updatedAt|modifiedAt)$/.test(key)) v = T.updated;
  else if (/(At|Since|On)$|^(at|serverNow|when|now)$/.test(key)) v = T.recent;
  else if (/^width$/.test(key)) v = 320;
  else if (/^height$/.test(key)) v = 100;
  else if (/size|bytes/i.test(key)) v = 24576;
  else if (/PerMinute$/.test(key)) v = 60;
  else if (/Ms$/.test(key)) v = 800 + (Number.parseInt(hex(key, 4), 16) % 1200);
  else if (/^attempts?$/.test(key)) v = 1;
  else if (/^since$/.test(key)) v = T.created;
  else if (/^status$|Status$/.test(key)) v = 200;
  else if (/limit/i.test(key)) v = 25;
  else if (/durationMinutes/.test(key)) v = 90;
  else if (/intervalSeconds/.test(key)) v = 300;
  else if (/failures|count|errors|refused|devices|registrations/i.test(key))
    v = /failures|errors|refused/i.test(key) ? 0 : 4 + (Number.parseInt(hex(key, 4), 16) % 30);
  else if (/^version$|Version$|generation|revision/i.test(key)) v = 3;
  else if (/total|passCount|used/.test(key)) v = 128;
  if (typeof s.minimum === 'number' && v < s.minimum) v = s.minimum;
  if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) v = s.exclusiveMinimum + 1;
  if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
  if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) v = s.exclusiveMaximum - 1;
  return s.type === 'integer' ? Math.round(v) : v;
}

export const kindOfOp = (tag: string): string => KIND_OF_TAG[tag] ?? 'row';

/** What a row's own id is called when its kind is also one of its foreign keys; `row` gets a fresh id. */
function ownKindOf(op: string): string {
  if (/Release/.test(op)) return 'release';
  if (/Candidate/.test(op)) return 'candidate';
  if (/Print/.test(op)) return 'print';
  if (/Event/.test(op)) return 'event';
  return 'row';
}

/** Fields that must agree with each other after sampling. */
function fixState(out: Json, props: Json, ctx: Ctx): void {
  const op = ctx.op;
  const num = (k: string): number | undefined =>
    typeof out[k] === 'number' ? (out[k] as number) : undefined;
  // Three sibling numbers that came out the same are nudged apart.
  const seen = new Map<number, string[]>();
  for (const [k, v] of Object.entries(out))
    if (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v < 1e12)
      seen.set(v, [...(seen.get(v) ?? []), k]);
  for (const [v, keys] of seen)
    if (keys.length >= 3) for (const [i, k] of keys.entries()) out[k] = v + i * 3;
  // A total is the sum of its parts.
  const parts = Object.keys(out).filter(
    (k) =>
      /^(done|failed|created|updated|unchanged|skipped|removed|ok|errors|refused|headsUp)$/.test(
        k,
      ) && num(k) !== undefined,
  );
  if (num('total') !== undefined && parts.length >= 2)
    out.total = parts.reduce((n, k) => n + (num(k) ?? 0), 0);
  if (
    num('recordsSeen') !== undefined &&
    (num('recordsFailed') ?? 0) > (num('recordsSeen') as number)
  )
    out.recordsFailed = 0;
  if (out.outcome === 'unchanged')
    for (const k of Object.keys(out)) if (/Changed$/.test(k)) out[k] = 0;
  if (num('lastSuccessAt') !== undefined && num('lastSuccessAt') === num('lastFailureAt'))
    out.lastFailureAt = (num('lastSuccessAt') as number) - 6 * 3_600_000;
  if (out.state === 'delivered') {
    const nullable = Array.isArray(props.nextAt?.type) && props.nextAt.type.includes('null');
    if ('nextAt' in out && !nullable) {
      // The schema always carries a next attempt, so the everyday row is a retry that is scheduled.
      out.state = 'pending';
      out.nextAt = T.soon;
      if ('lastStatus' in out) out.lastStatus = 503;
    } else {
      if ('nextAt' in out) out.nextAt = null;
      if ('lastStatus' in out) out.lastStatus = 200;
    }
    if ('replays' in out) out.replays = 1;
  }
  if (
    /^(pending|queued|running|scheduled)$/.test(String(out.state ?? out.status ?? '')) &&
    'finishedAt' in out
  )
    out.finishedAt = null;
  if ((out.state ?? out.status) === 'failed' && 'errorCode' in out && out.errorCode === null)
    out.errorCode = errorCodeFor(ctx.doc, op);
  for (const born of ['createdAt', 'receivedAt'])
    if (
      num('updatedAt') !== undefined &&
      num(born) !== undefined &&
      (num('updatedAt') as number) < (num(born) as number)
    )
      out.updatedAt = num(born);
  if ('state' in out && /^nfc-tags\..*Lost$/.test(op)) out.state = 'lost';
  if ('state' in out && /^nfc-tags\..*Retire$/.test(op)) {
    out.state = 'retired';
    if ('status' in out) out.status = 'retired';
  }
  // A call that went through carries no error code, and its path is its route.
  if ('route' in out && typeof out.status === 'number') {
    out.path = out.route;
    if ('code' in out) out.code = out.status >= 400 ? 'VALIDATION' : null;
  }
  if (out.outcome === 'unchanged')
    for (const k of Object.keys(out))
      if (/^passes/.test(k) && typeof out[k] === 'number') out[k] = 0;
  if (typeof out.records === 'number' && out.counts && typeof out.counts === 'object') {
    const c = out.counts as Record<string, unknown>;
    // Waiting records are a part of the created ones; a released template has none.
    if ('waiting' in c) c.waiting = 0;
    out.records = ['create', 'update', 'unchanged', 'skipped', 'errors'].reduce(
      (n, k) => n + (typeof c[k] === 'number' ? (c[k] as number) : 0),
      0,
    );
    if (typeof out.detail === 'string' && out.detail.startsWith('Read '))
      out.detail = `Read ${out.records} records from the sheet.`;
  }

  if (
    /^(healthy|ok|active)$/.test(
      ([out.state, out.status, out.health].find((v) => typeof v === 'string') as string) ?? '',
    ) &&
    typeof out.reason === 'string' &&
    !/^(ok|none)$/.test(out.reason) &&
    !(out.status === 400 && out.reason === 'BadDeviceToken')
  ) {
    const r = props.reason as Json | undefined;
    if (r?.enum?.includes('ok')) out.reason = 'ok';
    else if (Array.isArray(r?.type) && r.type.includes('null')) out.reason = null;
    else delete out.reason;
  }
  // A start is before its end.
  for (const [k, v] of Object.entries(out)) {
    const m = /^(.*?)(From|Start|Starts|Opens|Since)(At)?$/i.exec(k);
    if (!m || typeof v !== 'number') continue;
    for (const k2 of Object.keys(out)) {
      const e = /^(.*?)(Until|End|Ends|Closes|Before)(At)?$/i.exec(k2);
      if (e && e[1] === m[1] && typeof out[k2] === 'number' && v >= (out[k2] as number))
        out[k2] = v + 30 * 86_400_000;
    }
  }
  if ('prefix' in props && 'secretPrefix' in props && 'mode' in out) out.mode = 'test';
  if ('webhookUrl' in props && 'mode' in out) {
    const inbound = out.mode === 'webhook' || out.mode === 'hybrid';
    out.webhookUrl = inbound ? `${API}/hooks/connections/${IDS.connection}` : null;
    if ('hasWebhookSecret' in out) out.hasWebhookSecret = inbound;
    if ('webhookPrevUntil' in out) out.webhookPrevUntil = null;
    if (!inbound) delete out.webhookSecret;
  }
}
