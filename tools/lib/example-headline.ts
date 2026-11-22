// Examples written by hand for the operations people read first. The generator applies them over the sampled ones.
import { API, IDS, IMPORT_PLAN, MEMBERS_CSV, PASS, TEMPLATE } from './example-world.ts';

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
