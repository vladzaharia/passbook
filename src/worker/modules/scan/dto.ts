import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { armable, type ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { replacedBy } from '../passes/assets.ts';
import { readBranding } from '../passes/branding.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import { assetBaseUrl, prepareGenericAssetGrant } from './assets.ts';
import { passViewJson } from './card-pass-view.ts';
import { visibleIdentity, visibleSource } from './card-semantics.ts';
import { type CardPrivacy, cardPrivacy } from './dto-projection.ts';
import { gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import { activeFlags, type Found } from './resolve.ts';
import { scanPolicy } from './rules.ts';

export { cardAssetStmt } from './repo-dto.ts';

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

function cardValues(found: Found, actor: ScanActor, privacy: CardPrivacy): ScanValue[] {
  const seen = new Set<string>();
  const values: ScanValue[] = [];
  const props = (found.template.manifest.inputs.properties ?? {}) as Record<
    string,
    { type?: string; title?: string; 'x-label'?: string; 'x-format'?: string }
  >;
  for (const action of found.scan.actions) {
    if (
      !action.input ||
      seen.has(action.input) ||
      values.length >= 3 ||
      !visibleSource(found, actor, action.input, privacy) ||
      !privacy.safe(action.input)
    )
      continue;
    seen.add(action.input);
    const prop = props[action.input];
    const before = found.pass.personalization[action.input] ?? null;
    if (!privacy.valueSafe(before)) continue;
    const label = prop?.['x-label'] ?? prop?.title ?? action.input;
    values.push({
      input: action.input,
      label: privacy.safe(label) ? label : 'Value',
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
  lastScans: ScanCard['lastScans'];
}

export interface CardParts {
  found: Found;
  reads: CardReads;
  display: ScanCard['display'];
  /** The card's `ready` display is never built for a mode mismatch, so this is always a real pass. */
  assetNames: string[];
  /** Read-only previews and committing actions use distinct asset authority. */
  grantPurpose: 'read' | 'commit';
  /** Original authenticated recipient when display policy uses a derived event actor. */
  grantRecipientActor?: ScanActor;
}

/** A draft cannot be serialized as a complete card before its grant is confirmed. */
export type CardDraft = Omit<ScanCard, 'passView'> & {
  passView: Omit<ScanCard['passView'], 'assetGrant'>;
};

/** Match public pass-image replacement rules without further database reads. */
export async function cardAssets(
  ctx: ServiceContext,
  found: Found,
  result: D1Result | undefined,
): Promise<string[] | null> {
  const row = result?.results?.[0] as { branding?: unknown; asset_names?: unknown } | undefined;
  if (!row || typeof row.branding !== 'string' || typeof row.asset_names !== 'string') return null;
  let branding: unknown;
  let parsed: unknown;
  try {
    branding = JSON.parse(row.branding);
    parsed = JSON.parse(row.asset_names);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === 'string'))
    return null;
  const photoInPass = found.assetPhoto?.includeInPass === 1;
  const overrides = photoInPass
    ? [...parsed.filter((name) => !/^thumbnail(?:@[23]x)?\.png$/.test(name)), 'thumbnail@3x.png']
    : parsed;
  const own = replacedBy(overrides);
  const branded = (
    await brandingFiles(ctx.env.BUCKET, found.pass.orgId, readBranding(branding).images)
  )
    .map((image) => image.name)
    .filter((name) => !own(name));
  const taken = replacedBy([...overrides, ...branded]);
  const names = [
    ...found.template.assets
      .filter((image) => image.name.endsWith('.png') && !taken(image.name))
      .map((image) => image.name),
    ...branded,
    ...overrides,
  ];
  return photoInPass ? names.filter((name) => name !== 'thumbnail@3x.png') : names;
}

export async function buildCard(
  ctx: ServiceContext,
  actor: ScanActor,
  parts: CardParts,
): Promise<{ card: CardDraft; passViewGrant: PreparedAssetGrant } | null> {
  const { found, reads } = parts;
  const now = ctx.clock.now();
  const validity = validityOf(found.passJson, now);
  const privacy = cardPrivacy(found, actor);
  const identity = visibleIdentity(found, actor, privacy);
  // The card's visible pass has a redacted title; the grant must bind the original candidate.
  const original = found.liveCandidate;
  if (
    !original ||
    original.connectionGeneration !== found.connectionGeneration ||
    original.activeTemplateVersion !== found.activeVersion
  )
    return null;
  const passViewGrant = await prepareGenericAssetGrant(
    ctx,
    parts.grantRecipientActor ?? actor,
    original,
    original.connectionGeneration,
    original.activeTemplateVersion,
    parts.grantPurpose,
  );
  const assetNames = parts.assetNames;
  const lastScans = reads.lastScans;
  if (!passViewGrant) return null;
  const checkIn = found.scan.actions.find((a) => a.kind === 'check_in');
  const doorGate = checkIn
    ? reads.gates.find(
        (g) => g.action_id === checkIn.id && g.scope === gateScope(checkIn, actor, now),
      )
    : null;
  const card: CardDraft = {
    passId: found.pass.id,
    version: found.pass.version,
    mode: found.pass.mode,
    title: identity.title !== null && privacy.safe(identity.title) ? identity.title : '',
    subtitle:
      identity.subtitle !== null && privacy.safe(identity.subtitle) ? identity.subtitle : null,
    template: {
      id: found.template.id,
      name:
        typeof found.ref.name === 'string' && privacy.safe(found.ref.name) ? found.ref.name : '',
      style:
        typeof found.ref.style === 'string' && privacy.safe(found.ref.style) ? found.ref.style : '',
    },
    status: validity.status === 'active' ? 'active' : validity.status,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    flags: activeFlags(found, actor)
      .filter((flag) => privacy.safe(flag.label))
      .slice(0, 4)
      .map((f) => ({ label: f.label, tone: 'warning' as const, stop: f.stop })),
    values: cardValues(found, actor, privacy),
    actions: found.scan.actions
      .filter(
        (a) =>
          (a.input === undefined ||
            (typeof a.input === 'string' &&
              a.input.length > 0 &&
              visibleSource(found, actor, a.input, privacy))) &&
          typeof a.id === 'string' &&
          typeof a.label === 'string' &&
          privacy.safe(a.id) &&
          privacy.safe(a.label) &&
          (a.rewardLabel == null ||
            (typeof a.rewardLabel === 'string' && privacy.safe(a.rewardLabel))),
      )
      .slice(0, 6)
      .map((a) => ({
        ...cardAction(actor, a, reads.gates, now),
        ...(a.kind === 'check_in' && found.admission?.state.direction === 'out'
          ? { label: 'Check out' }
          : {}),
      })),
    checkIn: found.admission?.state,
    display: parts.display,
    lastScans,
    bundle: null,
    door: checkIn
      ? { state: doorGate?.state === 'in' || doorGate?.state === 'out' ? doorGate.state : null }
      : null,
    access: null,
    passView: {
      passJson: passViewJson(found, actor, privacy),
      assetBaseUrl: assetBaseUrl(found.pass.id),
      assetNames,
    },
  };
  return { card, passViewGrant };
}
