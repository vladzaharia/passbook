import catalog from '../../../docs/api/errors.json' with { type: 'json' };
import reached from '../../../docs/api/operation-codes.json' with { type: 'json' };

type Param = { name?: string; in?: string; $ref?: string };
type Op = {
  tags?: string[];
  description?: string;
  summary?: string;
  operationId?: string;
  security?: Record<string, unknown>[];
  'x-sign-in'?: string;
  'x-step-up'?: { maxAgeSec: number; conditional: boolean };
  parameters?: Param[];
  requestBody?: unknown;
  'x-codes'?: string[];
  /** Written by `register`: `<tag> <method> <path>`, the key of operation-codes.json. Removed here. */
  'x-route'?: string;
};
type Doc = { paths?: Record<string, Record<string, Op | undefined>> } & Record<string, unknown>;

/** Tags whose module directory has another name. Every other tag is its own directory. */
const TAG_MODULE: Record<string, string> = {
  scanners: 'scan',
  'scan-events': 'scan',
  'scan-zones': 'scan',
  'scan-staff': 'scan',
  'scan-display': 'scan',
  scans: 'scan',
  'roll-calls': 'scan',
  'nfc-tags': 'nfc',
  'nfc-keysets': 'nfc',
  'organization-memberships': 'orgs',
  brand: 'orgs',
  entitlements: 'orgs',
  offboard: 'orgs',
  'pass-imports': 'passes',
  'join-links': 'join',
  'google-wallet': 'wallet-providers',
  samsung: 'wallet-providers',
  'wallet-credentials': 'wallet-providers',
  'wallet-enrolments': 'wallet-providers',
  session: 'auth',
  connectors: 'connections',
};

const bySecurity = (op: Op): string[] => {
  const keys = (op.security ?? []).some((s) => 'apiKey' in s);
  return op.security?.length
    ? [
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'RATE_LIMITED',
        ...(keys ? ['API_KEY_MISSING', 'INVALID_API_KEY', 'MISSING_SCOPE'] : []),
        ...(op['x-sign-in'] === 'idp' || op['x-sign-in'] === 'oidc'
          ? ['IDP_SIGN_IN_REQUIRED']
          : []),
        ...(op['x-step-up'] ? ['STEP_UP_REQUIRED'] : []),
      ]
    : ['RATE_LIMITED'];
};

/** What an operation can answer with, besides its success: by shape, then by what its module throws. */
export function codesFor(path: string, op: Op): string[] {
  const own = new Set(bySecurity(op));
  if (op.requestBody || op.parameters?.length) own.add('VALIDATION');
  if (path.includes('{')) own.add('NOT_FOUND');
  // The parameter is added by reference (`withIdempotencyKey`), or inline where its text differs.
  if (
    op.parameters?.some((p) => p.name === 'Idempotency-Key' || p.$ref?.endsWith('/IdempotencyKey'))
  )
    for (const c of [
      'IDEMPOTENCY_IN_PROGRESS',
      'IDEMPOTENCY_KEY_INVALID',
      'IDEMPOTENCY_KEY_REUSED',
      ...(op.operationId === 'passes.postPasses' || op.operationId === 'broadcasts.postBroadcasts'
        ? ['IDEMPOTENCY_KEY_RESERVED']
        : []),
      ...(op.operationId === 'broadcasts.postBroadcasts' ? ['TELL_ALREADY_SENT'] : []),
    ])
      own.add(c);
  if (/If-Match/.test(`${op.summary} ${op.description}`)) own.add('VERSION_CONFLICT');
  const inferred = (reached as Record<string, string[]>)[op['x-route'] ?? ''];
  if (inferred) for (const c of inferred) own.add(c);
  else {
    // A route `register` did not see (or whose path is not a literal): its module's codes.
    const tag = op.tags?.[0] ?? '';
    const module = TAG_MODULE[tag] ?? tag;
    for (const c of catalog.codes) if (c.modules.includes(module)) own.add(c.code);
  }
  return [...own].sort();
}

/** Adds `x-codes` (the problem codes the operation can return) to every operation. */
export function withErrorCodes(doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const op of Object.values(item))
      if (op && typeof op === 'object') {
        op['x-codes'] = codesFor(path, op);
        delete op['x-route'];
      }
  return doc;
}
