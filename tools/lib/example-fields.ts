// Values for fields whose meaning the field name does not tell: codes the server writes into plain strings, fields an
// everyday record leaves empty, and free text, which comes from its family's sentences (example-text.ts).
// Each code rule cites where the server writes it, so a reader can check the example against the code.
import { type Family, familyOf, PROSE_KEYS, sentenceFor } from './example-text.ts';
import { BUNDLE_URL, IDS, JOIN_URL, PAIRING_CODE, SCAN_CODE } from './example-world.ts';

/** Leave an optional field out: the server omits it in the everyday case. */
export const OMIT = Symbol('omit');

type Rule = [op: RegExp, path: RegExp, value: unknown | ((path: string) => unknown)];
const ANY = /./;
const nth =
  <T>(list: readonly T[]) =>
  (path: string): T =>
    list[Number(path.match(/\[(\d+)\](?!.*\[\d+\])/)?.[1] ?? 0) % list.length] as T;

const RULES: Rule[] = [
  // Scan answers. A tag's passes and a group's members carry a scan reason only when refused (scan/tag-choose.ts,
  // scan/group.ts); the everyday answer admits them.
  [/^scans?\./, /\.tag\.passes\[\d+\]\.reason$/, null],
  [/^scans?\./, /\.members\[\d+\]\.reason$/, null],
  [/^scans?\./, /\.members\[\d+\]\.refusedReason$/, OMIT],
  [ANY, /\.byReason\[\d+\]\.reason$/, nth(['already_done', 'expired', 'no_balance'])],
  [ANY, /\.overrides\.latest\[\d+\]\.reason$/, nth(['already_done', 'no_balance'])],
  // The native shell reports VAS; a working reader reports no reason (scanning-sessions.ts).
  [ANY, /\.vas\.reason$/, ''],
  [/^scan\.getScanVisitors$/, /\.note$/, null],
  [ANY, /(^|\.)pairing\.code$/, PAIRING_CODE],
  [/^scan\.postScanPair/, /^\.code$/, PAIRING_CODE],
  [/^scan\./, /(\.input|\.card|\.items\[\d+\])\.code$/, SCAN_CODE],
  [/^roll-calls\.|RollCall/, /\.results\[\d+\]\.code$/, OMIT],
  [ANY, /\.customer\.greet$/, 'Hi, Ada'],
  // Links: a bundle's and a join link's pages, the org's web logo, an endpoint's URL (bundles/service.ts,
  // join/links-state.ts, orgs/brand.ts).
  [/^bundles\./, /(^|\.items\[\d+\])\.url$/, BUNDLE_URL],
  [/^join-links\./, /\.link\.url$/, JOIN_URL],
  [ANY, /\.webLogo\.url$/, `/brand/${IDS.org}/9f2c4e1a7b3d.png`],
  [
    /^developer\./,
    /\.endpoints\[\d+\]\.url$/,
    'https://bookings.northwind.example.com/hooks/passbook',
  ],
  [ANY, /\.(walletIssuance\.\w+|issuance)$/, { state: 'enabled' }],
  // Channels: `reason` is present only when a channel is off (contracts/channels.ts), and the everyday pass has
  // every channel on that the org has.
  [ANY, /\.(channels|effective)\.\w+\.on$/, true],
  [ANY, /\.(channels|effective)\.\w+\.(reason|retiredAt|retiredCause)$/, OMIT],
  [ANY, /\.(walletIssuance\.\w+|issuance)\.reason$/, OMIT],
  [ANY, /\.(walletIssuance\.\w+|issuance)\.state$/, 'enabled'],
  // An APNs push that went through has no reason (delivery/push.ts).
  [ANY, /\.lastPush\.ok$/, true],
  [ANY, /\.lastPush\.httpStatus$/, 200],
  [ANY, /\.lastPush\.reason$/, null],
  // A probe with a dummy token is healthy when Apple rejects the token, not the certificate (identities/apns-probe.ts).
  [/ApnsCheck$/, /^\.status$/, 400],
  [/ApnsCheck$/, /^\.reason$/, 'BadDeviceToken'],
  // Bulk runs: a done run has no code (passes/bulk-run-chunk.ts); a printable ticket code is `P` plus 26 base32.
  [/^passes\..*BulkRuns/, /(^|\.run)\.code$/, null],
  [/^passes\.postPassesByIdPrints$/, /^\.code$/, 'P7QK2XJ4MZ3TBWHN5RVC6DLE4A'],
  [/^passes\.postPassesBulk$/, /\.skipped\[\d+\]\.code$/, 'NO_RECIPIENT'],
  [/^passes\.postPassesBulkChannels$/, /\.skipped\[\d+\]\.code$/, 'RATE_LIMITED'],
  [/^passes\.postPassesBulkPrint$/, /\.skipped\[\d+\]\.code$/, 'PRINTING_OFF'],
  [/^passes\.postPassesBulkPrint$/, /\.skipped\[\d+\]\.reason$/, 'Paper is off for Day pass'],
  // Imports: what undo kept, and why (passes/import-undo-run.ts, import-remove.ts).
  [/^pass-imports\./, /\.kept\[\d+\]\.code$/, 'IMPORT_PASS_SCANNED'],
  [/^pass-imports\./, /\.skipped\[\d+\]\.code$/, 'IMPORT_PASS_CHANGED'],
  // Previews list only blocked patches (broadcasts/change-ops.ts) and failing samples (connections/preview.ts).
  [/^broadcasts\./, /\.blocked\[\d+\]\.code$/, 'NOT_A_DATE'],
  [/^connections\./, /\.samples\[\d+\]\.message$/, OMIT],
  [/^connections\./, /^\.detail$/, '3 rows. Columns: Booking ID, Name, Email, Plan, Valid until'],
  [ANY, /\.(connectorType|connector)$/, 'csv-url'],
  // An API key's recent calls: only a denied call carries a code (api-keys/repo-family.ts).
  [/^api-keys\./, /\.recent\[\d+\]\.code$/, null],
  // A provider check that passed has no code (wallet-providers/account-check.ts).
  [/ChecksByCheckId$/, /^\.code$/, null],
  [/^users\./, /\.identities\[\d+\]\.subject$/, 'c2a1f6e0-5b7d-4e3a-9f12-6d8b4a0e7c35'],
  [/^users\./, /\.identities\[\d+\]\.provider$/, 'pocketid'],
  [/^sandbox\./, /\.subject$/, 'Your Northwind Climbing pass'],
  [/^sandbox\./, /\.text$/, 'Your pass is ready. Day pass for Ada Example.'],
  // The admin's own words, where the field is free text.
  [/^webhooks\./, /(^|\.endpoint|\.items\[\d+\])\.description$/, 'Front-desk check-in sync'],
  [/^templates\./, /\.report\.issues\[\d+\]\.code$/, 'IMAGE_DERIVED'],
  [/^templates\./, /\.report\.issues\[\d+\]\.message$/, 'icon@2x.png derived from the @3x image.'],
  [/^templates\./, /\.report\.issues\[\d+\]\.severity$/, 'warning'],
  [/^templates\./, /\.report\.issues\[\d+\]\.path$/, 'icon@2x.png'],
  [/^templates\./, /\.warnings\[\d+\]\.code$/, 'SLOT_UNUSED'],
  [
    /^templates\./,
    /\.warnings\[\d+\]\.message$/,
    'strip.png is not used by generic; left out of the pass.',
  ],
  [/^templates\./, /\.warnings\[\d+\]\.path$/, 'strip.png'],
  [/^templates\./, /\.warnings\[\d+\]\.severity$/, 'warning'],
  [/^templates\./, /\.(warnings|issues)\[\d+\]\.(params|fix)$/, OMIT],
  // Setup checks: a pass-setup check carries its sentence (shared/copy/pass-setup.ts); a scanner setup check names a
  // copy key and its params (shared/scan-setup-checks.ts).
  [
    /^pass-setup\./,
    /\.checks$/,
    [
      {
        code: 'APPLE_SHARED_ID',
        level: 'info',
        area: 'channels',
        message: "Apple passes sign with PassBook's shared ID.",
        fix: { action: 'start_apple_managed' },
      },
    ],
  ],
  [
    /^scanners\./,
    /\.checks$/,
    [
      {
        code: 'NO_EXIT',
        level: 'warn',
        message: 'noExit',
        params: { place: 'Main hall' },
        door: 'door-1',
      },
    ],
  ],
  // A capture holds the body exactly as it would have been signed and sent (webhooks/payload.ts).
  [
    /^webhooks\./,
    /\.body$/,
    JSON.stringify({
      id: '0193a1b2-7c00-7000-8000-000000000033',
      type: 'pass.issued',
      apiVersion: '2026-12-01',
      createdAt: 1795572300000,
      orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
      mode: 'test',
      pass: {
        id: '0193a1b2-7c00-7000-8000-0000000000c1',
        externalId: 'booking_8841',
        templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
      },
      data: { version: 1, source: 'api' },
    }),
  ],
];

/** Keys that hold a machine error code. */
export const ERROR_KEYS = /^(errorCode|lastErrorCode|syncErrorCode|error|lastError|pausedCode)$/;

/**
 * Codes the server stores on a record of the family, which no route returns as an HTTP error (a connector's failure, a
 * delivery's): connectors/types.ts, connections/webhook-process.ts, webhooks/deliver.ts, templates/upload.ts,
 * passes/bulk-run-chunk.ts.
 */
export const STORED_CODES: Partial<Record<Family, readonly string[]>> = {
  connections: [
    ...['AUTH', 'FORBIDDEN', 'RATE_LIMITED', 'UPSTREAM', 'TIMEOUT', 'INVALID_PAYLOAD', 'CONFIG'],
    ...['INTERNAL', 'RECORD_ERRORS', 'STALE_CONTEXT', 'RUN_LOST'],
    ...['WEBHOOK_UPSTREAM', 'WEBHOOK_TIMEOUT', 'WEBHOOK_AUTH', 'WEBHOOK_EFFECT_UNCERTAIN'],
    ...['WEBHOOK_DEAD_LETTER', 'WEBHOOK_STALE_CONTEXT', 'WEBHOOK_PAYLOAD_MISSING'],
  ],
  webhooks: [
    ...['UPSTREAM', 'TIMEOUT', 'REDIRECT_BLOCKED', 'RESPONSE_TOO_LARGE', 'UNSAFE_URL'],
    ...['SECRET_UNAVAILABLE', 'RATE_LIMITED', 'UNSUBSCRIBED', 'PASS_GONE', 'ENDPOINT_DISABLED'],
  ],
  templates: ['IMPORT_INVALID', 'IMPORT_FAILED', 'UPLOAD_MISSING', 'NOT_A_ZIP', 'ZIP_INVALID'],
  passes: ['BULK_RUN_STOPPED', 'BULK_RUN_STALLED', 'BULK_RUN_FAILED', 'PUSH_UNAVAILABLE'],
};

/** What a failed record of each family most often says, first match wins. */
const LIKELY: Record<Family, readonly string[]> = {
  scan: ['TAG_REQUEST_EXPIRED', 'SCANNER_OFFLINE'],
  passes: ['PUSH_UNAVAILABLE', 'PASS_CONFLICT'],
  templates: ['NOT_A_ZIP', 'TEMPLATE_CONTENT_CHANGED'],
  rollouts: ['PASS_CONFLICT'],
  imports: ['IMPORT_FILE_GONE', 'IMPORT_HEADER_TOO_LONG'],
  connections: ['WEBHOOK_UPSTREAM', 'UPSTREAM'],
  webhooks: ['UPSTREAM', 'TIMEOUT'],
  messages: ['IDENTITY_EXPIRED', 'MESSAGING_UNSUPPORTED'],
  org: ['ORG_EXPORT_RUNNING'],
  identities: ['IDENTITY_NOT_READY', 'APNS_BINDING_MANAGED'],
  status: ['UPSTREAM'],
};
/** Codes that say who may call, not what went wrong with a record. */
const CALLER =
  /^(FORBIDDEN|UNAUTHENTICATED|MISSING_SCOPE|INVALID_API_KEY|IDP_SIGN_IN_REQUIRED|ORG_\w+|RATE_LIMITED|VALIDATION|NOT_FOUND|IDEMPOTENCY_\w+|STEP_UP\w*|\w+_NOT_FOUND)$/;

// biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is untyped JSON here
type Doc = Record<string, any>;
const opCodes = new WeakMap<Doc, Map<string, string[]>>();
function codesByOp(doc: Doc): Map<string, string[]> {
  let map = opCodes.get(doc);
  if (map) return map;
  map = new Map();
  for (const item of Object.values<Doc>(doc.paths ?? {}))
    for (const op of Object.values<Doc>(item))
      if (op?.operationId) map.set(op.operationId, op['x-codes'] ?? []);
  opCodes.set(doc, map);
  return map;
}

/** The codes a record of this operation may carry: the operation's, its resource's other routes', and stored ones. */
export function allowedCodes(doc: Doc, op: string): Set<string> {
  const tag = op.split('.')[0];
  const out = new Set(STORED_CODES[familyOf(op)] ?? []);
  for (const [id, codes] of codesByOp(doc))
    if (id === op || id.split('.')[0] === tag) for (const c of codes) out.add(c);
  return out;
}

/** A code for a record that failed: the family's likely one where the operation can carry it, else its own first. */
export function errorCodeFor(doc: Doc, op: string): string {
  const allowed = allowedCodes(doc, op);
  const own = (codesByOp(doc).get(op) ?? []).filter((c) => !CALLER.test(c));
  return (
    LIKELY[familyOf(op)].find((c) => allowed.has(c)) ??
    own[0] ??
    [...allowed].find((c) => !CALLER.test(c)) ??
    'UPSTREAM'
  );
}

interface FieldCtx {
  op: string;
  request: boolean;
}

/**
 * The value a field takes in the world, or undefined to let the sampler decide. `OMIT` leaves an optional field out.
 * Error-code fields are empty on an everyday record; prose fields take their family's sentence.
 */
export function fieldValue(ctx: FieldCtx, key: string, path: string): unknown {
  for (const [op, at, value] of RULES)
    if (op.test(ctx.op) && at.test(path))
      return typeof value === 'function' ? (value as (p: string) => unknown)(path) : value;
  if (ERROR_KEYS.test(key)) return null;
  if (PROSE_KEYS.test(key)) return sentenceFor(ctx.op, key, path);
  return undefined;
}
