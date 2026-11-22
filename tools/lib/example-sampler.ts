// Builds an example from a schema and the fictional world (example-world.ts): values by field name, then format.
import {
  API,
  CANON,
  hex,
  IDS,
  KIND_OF_TAG,
  NAMES,
  ORG,
  ORG_SLUG,
  SITE,
  T,
  TEMPLATE,
  TEXT,
} from './example-world.ts';

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
function nameFor(key: string, kind: string): string {
  if (/^(org|organization)Name$/.test(key)) return ORG;
  if (/template/i.test(key)) return NAMES.template as string;
  if (/scanner|device/i.test(key))
    return /device/i.test(key) ? (NAMES.device as string) : (NAMES.scanner as string);
  if (/event/i.test(key)) return NAMES.event as string;
  if (/zone|place/i.test(key)) return NAMES.zone as string;
  if (/key/i.test(key)) return NAMES.key as string;
  return (NAMES[kind] as string) ?? 'Day pass';
}

const PERSON_KEY =
  /^(holder|member|person|owner|host|visitor|staff|admin|author|reviewer|createdBy|startedBy|endedBy|requestedBy|versionAuthor|actor)(Name)?$|ByName$|^by$/;

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
      () =>
        ctx.kind === 'key'
          ? `pb_live_${hex(`${ctx.op}${k}`, 32)}`
          : `whsec_${hex(`${ctx.op}${k}`, 32)}`,
    ],
    [/^(secretPrefix|prefix)$/, () => (ctx.kind === 'key' ? 'pb_live_8Qw3' : 'whsec_4f9a')],
    [/^(token|apiKey|rawKey)$/, () => `pb_live_${hex(`${ctx.op}${k}`, 32)}`],
    [/^(privateKeyPem|keyPem|pem)$/, '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'],
    [
      /^(certificatePem|publicKeyPem)$/,
      '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----',
    ],
    [
      /^(lastErrorCode|syncErrorCode|errorCode|voidCause|refused|refusedReason|error)$/,
      () =>
        k === 'voidCause'
          ? 'refund'
          : k === 'refused' || k === 'refusedReason'
            ? 'expired'
            : TEXT.errorCode,
    ],
    [/^(reason|refusedLine)$/, TEXT.reason],
    [
      /^(message|text|welcome|body|detail|errorDetail|note|subject)$/,
      () =>
        k === 'note'
          ? TEXT.note
          : k === 'detail' || k === 'errorDetail'
            ? TEXT.detail
            : k === 'subject'
              ? 'Your day pass'
              : TEXT.message,
    ],
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
    [/^(downloadUrl)$/, () => `${SITE}/p/${IDS.pass}.pkpass`],
    [/^(publicUrl|url|link|joinUrl|pageUrl)$/, () => `${SITE}/p/xK3v9QmT2Lw8`],
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
      return 'Day pass';
    case 'values':
      return 'Day pass';
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
      return /email|rule|broadcast/i.test(ctx.op) ? 'hello@example.com' : 'Booking sheet';
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
      return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==';
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
      return `ya29.${hex(`${ctx.op}${path}`, 40)}`;
    case 'types':
    case 'type_':
      return 'wristband';
    case 'uid':
      return '04A3B2C1D5E680';
    case 'undoes':
      return IDS.scan;
    case 'urlMasked':
      return 'https://hooks.example.com/…';
    case 'assetName':
      return 'logo.png';
    case 'adapterCapability':
      return 'read';
    case 'alias':
      return 'daypass';
    case 'actionId':
    case 'defaultActionId':
      return 'admit';
    case 'idempotencyKey':
      return `0193a1b2-7c00-7000-8000-${hex(`${ctx.op}${path}`, 12)}`;
    default:
      return undefined;
  }
}

/** A name field: a person in person fields, a resource name elsewhere. */
function nameField(key: string, kind: string, path: string): string | undefined {
  if (!/[nN]ame$|^name$|^label$|^title$|^subtitle$/.test(key)) return undefined;
  if (
    /holder|member|owner|host|visitor|staff|admin|author|reviewer|createdBy|startedBy|endedBy|requestedBy/i.test(
      key + path,
    )
  )
    return key === 'subtitle' ? 'Ada Example' : 'Sam Rivera';
  if (/^subtitle$/.test(key)) return 'Ada Example';
  if (/^(ownerName)$/.test(key)) return 'Ada Example';
  return nameFor(key, kind);
}

const PREFER = ['healthy', 'active', 'ok', 'done', 'ready', 'live', 'succeeded', 'standard'];
function pickEnum(values: unknown[], key: string): unknown {
  if (values.includes(null) && /^(reason|milestone|turnaround)$/.test(key)) return null;
  if (values.includes('')) return '';
  if (key === 'screen') return 'ok';
  return PREFER.find((p) => values.includes(p)) ?? values.find((x) => x !== null) ?? values[0];
}

/** Fields that describe a resource gone wrong or retired; an everyday example leaves them empty. */
const STATE_KEYS =
  /^(revokedAt|retireAt|retiredAt|removedAt|disabledAt|deletedAt|archivedAt|failingSince|rotatedFrom|parentKeyId|previous\w*|breakerOpenUntil|undoUntil|lastError\w*|syncErrorCode|errorDetail|errorCode|errorFile|voidedAt|expiredAt|matched|pushBudget|blocked\w*|pairedAt|pairedBy\w*|lastStatus)$/;

const TRUE_KEYS = /^(is|has|can|allow|enabled|active|ok|sendEmail|valid|live|default)/;

export function sample(
  ctx: Ctx,
  schema: Json | undefined,
  key: string,
  path: string,
  kind: string,
  depth: number,
): unknown {
  const s = resolve(ctx, schema);
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (s.enum) return pickEnum(s.enum, key);
  const alts = s.oneOf ?? s.anyOf;
  if (alts) {
    const non = alts.filter((a: Json) => resolve(ctx, a).type !== 'null');
    return sample(ctx, non[0] ?? alts[0], key, path, kind, depth);
  }
  if (s.allOf) {
    const named = s.allOf.find((a: Json) => a.$ref);
    if (named) return sample(ctx, named, key, path, kind, depth);
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t: string) => t !== 'null') ?? type[0];
  if (!type && s.properties) type = 'object';
  const subKind = KIND_KEYS[key.replace(/Id$/, '')] ?? kind;
  switch (type) {
    case 'string':
      return str(ctx, s, key, path, subKind);
    case 'integer':
    case 'number':
      return num(ctx, s, key);
    case 'boolean':
      return TRUE_KEYS.test(key);
    case 'null':
      return null;
    case 'array': {
      if (depth > 6) return [];
      if (s.prefixItems)
        return s.prefixItems.map((it: Json, i: number) =>
          sample(ctx, it, key, `${path}[${i}]`, subKind, depth + 1),
        );
      const n = Math.max(1, s.minItems ?? 1);
      const item =
        key === 'aliases'
          ? 'alias'
          : key
              .replace(/Ids$/, 'Id')
              .replace(/ities$/, 'ity')
              .replace(/(?<!s)s$/, '');
      return Array.from({ length: Math.min(n, 2) }, (_, i) =>
        sample(ctx, s.items, item, `${path}[${i}]`, KIND_KEYS[item] ?? subKind, depth + 1),
      );
    }
    case 'object':
      return object(ctx, s, key, path, subKind, depth);
    default:
      return {};
  }
}

function object(
  ctx: Ctx,
  s: Json,
  key: string,
  path: string,
  kind: string,
  depth: number,
): unknown {
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
  const canon = ctx.request ? {} : (CANON.find((c) => c.has.every((k) => k in props))?.value ?? {});
  const required: string[] = s.required ?? [];
  let optional = 0;
  const cap = ctx.request ? (depth === 0 ? 3 : 2) : 14;
  for (const [k, v] of Object.entries<Json>(props)) {
    if (!(k in canon) && STATE_KEYS.test(k)) {
      // A state an ordinary example is not in: null where the field allows it, else absent.
      const nullable = Array.isArray(v.type) && v.type.includes('null');
      if (nullable) {
        out[k] = null;
        continue;
      }
      if (!required.includes(k)) continue;
    }
    if (!required.includes(k) && !(k in canon) && Object.keys(canon).length) continue;
    if (!required.includes(k) && !(k in canon)) {
      if (v.deprecated || optional >= cap || depth > 4) continue;
      optional++;
    }
    out[k] = k in canon ? canon[k] : sample(ctx, v, k, `${path}.${k}`, kind, depth + 1);
  }
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
    return /foreground|label/i.test(path)
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
  if (/Field$/.test(key)) return contextString(key, kind, path, ctx) ?? '/Holder email';
  if (f === 'email' || /email/i.test(key))
    return /host|staff|admin/i.test(key)
      ? 'sam@example.com'
      : /support|help/i.test(key)
        ? 'help@example.com'
        : 'ada@example.com';
  if (f === 'uri' || f === 'url') return `${SITE}/p/xK3v9QmT2Lw8`;
  if (
    f === 'uuid' ||
    /^id$|Id$|^serial$|^serialNumber$|^(createdBy|updatedBy|startedBy|endedBy|requestedBy)$/.test(
      key,
    )
  ) {
    const base = key.replace(/Id$/, '');
    const k =
      KIND_KEYS[base] ??
      KIND_KEYS[base.replace(/^.*(?=[A-Z])/, '').replace(/^./, (c) => c.toLowerCase())] ??
      (/^id$/.test(key) ? kind : undefined);
    const hit = k ? IDS[k] : undefined;
    return hit ?? `0193a1b2-7c00-7000-8000-${hex(`${ctx.op}${path}`, 12)}`;
  }
  const name = nameField(key, kind, path);
  if (name) return name;
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
    else if (/(Url|Uri)$/.test(key)) v = `${SITE}/p/xK3v9QmT2Lw8`;
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

const PATTERNS: [string, (seed: string) => string][] = [
  ['^([01]\\d|2[0-3]):[0-5]\\d-(([01]\\d|2[0-3]):[0-5]\\d|24:00)$', () => '09:00-21:00'],
  ['^(zone|event):\\S{1,64}$', () => 'zone:main-hall'],
  ['^[0-9A-F]{4}$', (s) => hex(s, 4).toUpperCase()],
  ['^[0-9a-f]{40}$', (s) => hex(s, 40)],
  ['^[0-9a-f]{64}$', (s) => hex(s, 64)],
  ['^[0-9a-f]{8}$', (s) => hex(s, 8)],
  ['^[a-z0-9]{8}$', (s) => hex(s, 8)],
  ['^[0-9a-fA-F]{32}$', (s) => hex(s, 32)],
  ['^([01]\\d|2[0-3]):[0-5]\\d$', () => '04:00'],
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

function num(ctx: Ctx, s: Json, key: string): number {
  let v = 3;
  if (/validFrom$|^windowFrom$|From$/.test(key)) v = T.validFrom;
  else if (/validUntil$|Until$|After$|^notAfter$|expiresAt$|^expires/.test(key))
    v = /breaker/.test(key) ? T.soon : /undo/.test(key) ? T.soon : T.validUntil;
  else if (/^(createdAt|startedAt|firstSeenAt|notBefore)$/.test(key)) v = T.created;
  else if (/^(updatedAt|modifiedAt)$/.test(key)) v = T.updated;
  else if (/(At|Since)$/.test(key)) v = T.recent;
  else if (/^width$/.test(key)) v = 320;
  else if (/^height$/.test(key)) v = 100;
  else if (/size|bytes/i.test(key)) v = 24576;
  else if (/PerMinute$/.test(key)) v = 60;
  else if (/Status$/.test(key)) v = 200;
  else if (/limit/i.test(key)) v = 25;
  else if (/durationMinutes/.test(key)) v = 90;
  else if (/intervalSeconds/.test(key)) v = 300;
  else if (/failures|count|errors|refused|devices|registrations/i.test(key))
    v = /failures|errors|refused/i.test(key) ? 0 : 12;
  else if (/^version$|Version$|generation|revision/i.test(key)) v = 3;
  else if (/total|passCount|used/.test(key)) v = 128;
  if (typeof s.minimum === 'number' && v < s.minimum) v = s.minimum;
  if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) v = s.exclusiveMinimum + 1;
  if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
  if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) v = s.exclusiveMaximum - 1;
  return s.type === 'integer' ? Math.round(v) : v;
}

export const kindOfOp = (tag: string): string => KIND_OF_TAG[tag] ?? 'pass';
