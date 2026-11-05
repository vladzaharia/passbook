/** Sample data for the editor's preview (DM 6.6): a scope, a history and nothing a pass really holds. */
import type { Json, TemplateManifest } from '../../types.ts';
import { PASS_STYLES } from '../../types.ts';
import { applyDefaults, projectDisplay } from '../manifest.ts';
import { firstActionInput } from './presets-kit.ts';
import { actionGoals } from './scope.ts';
import type { ScanDisplayScope } from './text.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * History as the server will supply it (DS.4): counts, last visit, the ledger and the row lists.
 * `value` is the input's current value, so the newest listed scan ends 4 above it and the
 * ledger shows one "Changed elsewhere" row.
 */
export function sampleHistory(
  now: number,
  options: { input?: string | null; value?: number } = {},
): Record<string, Json> {
  const input = options.input ?? 'balance';
  const value = options.value ?? 25;
  const entry = (ago: number, amount: number, after: number, label: string, where: string) => ({
    at: now - ago,
    amount,
    after,
    label,
    where,
  });
  return {
    lastVisit: { at: now - 2 * DAY, where: 'Door 1' },
    visits: { today: 0, week: 3, month: 6, year: 41, total: 58 },
    scans: { today: 0, total: 74 },
    lastScan: { at: now - 2 * DAY, where: 'Door 1', action: 'Check in' },
    checkedInAt: null,
    inside: false,
    ledger: {
      [input]: {
        last: { at: now - 3 * HOUR, amount: -6.5, label: 'Charge' },
        month: { in: 40, out: -23.5 },
      },
    },
    list: {
      visits: [
        { at: now - 2 * DAY, where: 'Door 1' },
        { at: now - 5 * DAY, where: 'Door 1' },
        { at: now - 9 * DAY, where: 'Console' },
      ],
      scans: [
        { at: now - 2 * DAY, label: 'Check in', where: 'Door 1' },
        { at: now - 5 * DAY, label: 'Check in', where: 'Door 1' },
      ],
      value: {
        [input]: [
          entry(3 * HOUR, -6.5, value + 4, 'Charge', 'Till 1'),
          entry(2 * DAY, -12, value + 10.5, 'Charge', 'Till 1'),
          entry(6 * DAY, 20, value + 22.5, 'Top up', 'Console'),
        ],
      },
    },
  };
}

const isObject = (v: unknown): v is Record<string, Json> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A scope for `renderScanDisplay`: the manifest's sample, sample history, event and scanner. */
export function sampleScope(
  manifest: TemplateManifest,
  overrides: ScanDisplayScope = {},
): ScanDisplayScope {
  const now = typeof overrides.now === 'number' ? overrides.now : Date.now();
  const inputs = applyDefaults(manifest, manifest.sample);
  const projection = projectDisplay(manifest, manifest.sample);
  const input = firstActionInput(manifest);
  const current = input && typeof inputs[input] === 'number' ? (inputs[input] as number) : 0;
  const action = manifest.scan?.actions?.[0];
  const step = typeof action?.amount === 'number' ? action.amount : 1;
  const changes = !!input && (action?.kind === 'add' || action?.kind === 'take');
  const scope: ScanDisplayScope = {
    inputs,
    pass: {
      title: projection.title || manifest.name,
      subtitle: projection.subtitle ?? '',
      status: 'active',
      statusLabel: projection.status ?? 'Active',
      validFrom: now - 30 * DAY,
      validUntil: now + 90 * DAY,
      createdAt: now - 200 * DAY,
      version: 1,
      templateName: manifest.name,
      style: PASS_STYLES[0] ?? 'generic',
      externalId: 'SAMPLE-1',
    },
    scan: {
      outcome: 'ok',
      reason: null,
      at: now,
      method: 'camera',
      direction: 'in',
      action: {
        id: action?.id ?? 'check_in',
        label: action?.label ?? 'Check in',
        kind: action?.kind ?? 'check_in',
      },
      ...(changes && input ? { input, amount: step, before: current - step, after: current } : {}),
    },
    history: sampleHistory(now, { input, value: current }),
    event: {
      name: 'Sample event',
      opensAt: now - HOUR,
      closesAt: now + 3 * HOUR,
      arrived: 128,
      expected: 400,
      capacity: 500,
    },
    scanner: { name: 'Door 1', role: 'door' },
    lookups: (manifest.lookups ?? {}) as Json,
    goals: actionGoals(manifest),
    assets: {},
    fields: {},
    templateVersion: 'sample',
    now,
  };
  for (const [key, value] of Object.entries(overrides)) {
    const base = scope[key];
    scope[key] = isObject(base) && isObject(value) ? { ...base, ...value } : value;
  }
  return scope;
}
