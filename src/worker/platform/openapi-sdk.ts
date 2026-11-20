import names from '../../../docs/api/sdk-names.json' with { type: 'json' };

type SdkName = { resource: string; method: string; sdk?: boolean; reason?: string };
type Op = { operationId?: string; 'x-sdk'?: unknown };
type Doc = { paths?: Record<string, Record<string, Op | undefined>> } & Record<string, unknown>;

const table = names as Record<string, SdkName>;

/** Adds `x-sdk` from docs/api/sdk-names.json. An operation with no entry gets nothing; the tests fail instead. */
export function withSdkNames(doc: Doc): Doc {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      const entry = op?.operationId ? table[op.operationId] : undefined;
      if (!op || !entry) continue;
      op['x-sdk'] = {
        resource: entry.resource,
        method: entry.method,
        ...(entry.sdk === false ? { sdk: false, reason: entry.reason } : {}),
      };
    }
  }
  return doc;
}
