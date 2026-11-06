import type { PassJson } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { maskEmail } from '../../../shared/email.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { armable, type ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { passImages } from '../public/service.ts';
import { assetBaseUrl, mintAssetGrant } from './assets.ts';
import { gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import { activeFlags, type Found } from './resolve.ts';
import { scanPolicy } from './rules.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HIDDEN = [
  'barcode',
  'barcodes',
  'nfc',
  'authenticationToken',
  'webServiceURL',
  'serialNumber',
];

/** The pass JSON the scanner may show: no barcode, NFC, token, URL, serial or readable email. */
export function stripPassJson(passJson: PassJson): Json {
  const walk = (value: unknown): Json => {
    if (typeof value === 'string') return EMAIL.test(value) ? maskEmail(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return (value ?? null) as Json;
  };
  const copy = { ...(passJson as unknown as Record<string, unknown>) };
  for (const key of HIDDEN) delete copy[key];
  return walk(copy);
}

export const policyActor = (actor: ScanActor) => ({
  principal: actor.principal,
  role: actor.role ?? 'door',
  terminal: actor.terminal,
  actorKey: actor.actorKey,
  staffId: actor.staff?.id ?? null,
  settings: actor.settings,
});

export interface GateSeen {
  action_id: string;
  scope: string;
  state: string;
  last_at: number;
}
export interface ScanSeen {
  id: string;
  at: number;
  action_id: string | null;
  outcome: 'ok' | 'heads_up' | 'refused';
  actor_key: string;
  undone_by: string | null;
  scanner_name: string | null;
}

/** One action as the card offers it: whether it is open to this actor, and why not. */
function cardAction(
  actor: ScanActor,
  action: ResolvedScanAction,
  gates: GateSeen[],
  now: number,
): ScanCard['actions'][number] {
  const verdict = scanPolicy(policyActor(actor), { kind: 'act', minRole: action.minRole });
  const lock = verdict.allow ? null : verdict.why === 'needs_approval' ? 'approval' : 'role';
  const scope = gateScope(action, actor, now);
  const gate = gates.find((g) => g.action_id === action.id && g.scope === scope);
  let reason: ScanCard['actions'][number]['reason'] = null;
  let remaining: number | null = null;
  if (gate && action.repeat === 'cooldown') {
    remaining = Math.max(0, gate.last_at + (action.cooldownMinutes ?? 5) * 60_000 - now);
    if (remaining > 0) reason = 'cooldown';
  } else if (gate && (action.repeat === 'once' || action.repeat === 'daily'))
    if (gate.state === 'in' || gate.state === 'used') reason = 'already_done';
  const amount = action.amount;
  return {
    id: action.id,
    label: action.label,
    kind: action.kind,
    available: lock === null && reason === null,
    lock,
    reason,
    amount:
      typeof amount === 'number'
        ? { fixed: amount }
        : amount
          ? { max: amount.max, presets: amount.presets ?? [], default: amount.default ?? null }
          : null,
    confirm: action.confirm,
    confirmAbove: action.confirmAbove ?? null,
    cooldownRemainingMs: remaining,
    armable: armable(action),
    rewardLabel: action.rewardLabel ?? null,
  };
}

/** System values from the actions' inputs: the number a take or add works on, with its label. */
type ScanValue = ScanCard['values'][number];

function cardValues(found: Found): ScanValue[] {
  const seen = new Set<string>();
  const values: ScanValue[] = [];
  const props = (found.template.manifest.inputs.properties ?? {}) as Record<
    string,
    { type?: string; title?: string; 'x-label'?: string; 'x-format'?: string }
  >;
  for (const action of found.scan.actions) {
    if (!action.input || seen.has(action.input) || values.length >= 3) continue;
    seen.add(action.input);
    const prop = props[action.input];
    const before = found.pass.personalization[action.input] ?? null;
    values.push({
      input: action.input,
      label: prop?.['x-label'] ?? prop?.title ?? action.input,
      before,
      after: null,
      goal: action.kind === 'take' && typeof action.amount === 'number' ? action.amount : null,
      format:
        prop?.['x-format'] === 'currency'
          ? 'currency'
          : prop?.type === 'string'
            ? 'text'
            : 'number',
    });
  }
  return values;
}

export interface CardReads {
  gates: GateSeen[];
  scans: ScanSeen[];
  undoWindowMinutes: number;
}

export interface CardParts {
  found: Found;
  reads: CardReads;
  display: ScanCard['display'];
  /** The card's `ready` display is never built for a mode mismatch, so this is always a real pass. */
  assetNames: string[];
}

export async function cardAssets(ctx: ServiceContext, found: Found): Promise<string[]> {
  const images = await passImages(ctx, found.pass);
  return images.map((i) => i.name);
}

export async function buildCard(
  ctx: ServiceContext,
  actor: ScanActor,
  parts: CardParts,
): Promise<ScanCard> {
  const { found, reads } = parts;
  const now = ctx.clock.now();
  const validity = validityOf(found.passJson, now);
  const checkIn = found.scan.actions.find((a) => a.kind === 'check_in');
  const doorGate = checkIn
    ? reads.gates.find(
        (g) => g.action_id === checkIn.id && g.scope === gateScope(checkIn, actor, now),
      )
    : null;
  return {
    passId: found.pass.id,
    version: found.pass.version,
    mode: found.pass.mode,
    title: found.pass.displayTitle ?? '',
    subtitle: found.pass.displaySubtitle,
    template: { id: found.template.id, name: found.ref.name, style: found.ref.style },
    status: validity.status === 'active' ? 'active' : validity.status,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    flags: activeFlags(found)
      .slice(0, 4)
      .map((f) => ({ label: f.label, tone: 'warning' as const, stop: f.stop })),
    values: cardValues(found),
    actions: found.scan.actions.slice(0, 6).map((a) => ({
      ...cardAction(actor, a, reads.gates, now),
      ...(a.kind === 'check_in' && found.admission?.state.direction === 'out'
        ? { label: 'Check out' }
        : {}),
    })),
    checkIn: found.admission?.state,
    display: parts.display,
    lastScans: reads.scans.map((s) => ({
      scanId: s.id,
      at: s.at,
      actionLabel: found.scan.actions.find((a) => a.id === s.action_id)?.label ?? 'Check in',
      outcome: s.outcome,
      scannerName: s.scanner_name ?? 'Scanner',
      undoable:
        s.outcome === 'ok' &&
        s.undone_by === null &&
        s.actor_key === actor.actorKey &&
        now - s.at <= reads.undoWindowMinutes * 60_000,
    })),
    bundle: null,
    door: checkIn
      ? { state: doorGate?.state === 'in' || doorGate?.state === 'out' ? doorGate.state : null }
      : null,
    access: null,
    passView: {
      passJson: stripPassJson(found.passJson),
      assetBaseUrl: assetBaseUrl(found.pass.id),
      assetGrant: await mintAssetGrant(ctx.env, actor.actorKey, found.pass.id, now),
      assetNames: parts.assetNames,
    },
  };
}
