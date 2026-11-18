/**
 * Semantic role resolution (architecture 2.2). First hit wins, fully deterministic:
 * 1. `wallets.roles.<role>` (a field key, an expression, or `false`),
 * 2. Apple `semantics`, root first, then fields front to back,
 * 3. the style default,
 * 4. none. Never a guess from field keys or labels.
 * `title` always exists: it falls back to the organization name.
 */
import type { WalletRoleSource } from '../template/wallets/schema.ts';
import type { Json } from '../types.ts';
import { type Hit, ROLE_RULES, type RoleInput } from './role-rules.ts';
import {
  type ResolvedRoles,
  type RoleScalar,
  type ViewLink,
  type ViewNote,
  WALLET_ROLES,
  type WalletRole,
} from './types.ts';
import { linkKind } from './view-fields.ts';

type Kind = RoleScalar['kind'];

/** The value type of every role (architecture 2.2, column "Type"). */
export const ROLE_KINDS: Record<WalletRole, Kind> = {
  title: 'text',
  subtitle: 'text',
  eventName: 'text',
  eventStart: 'date',
  eventEnd: 'date',
  doorsOpen: 'date',
  venueName: 'text',
  venueAddress: 'text',
  venueLocation: 'location',
  seat: 'text',
  row: 'text',
  section: 'text',
  gate: 'text',
  ticketHolder: 'text',
  ticketNumber: 'text',
  confirmationCode: 'text',
  eventId: 'text',
  memberId: 'text',
  memberName: 'text',
  tier: 'text',
  points: 'number',
  pointsLabel: 'text',
  balance: 'money',
  giftCardNumber: 'text',
  giftCardPin: 'text',
  offerTitle: 'text',
  offerDetails: 'text',
  finePrint: 'text',
  redemptionChannel: 'channel',
  validFrom: 'date',
  validUntil: 'date',
  appLink: 'app',
  support: 'links',
};

export type RoleEvaluator = (
  expr: Extract<WalletRoleSource, { value: unknown }>['value'],
) => Json | undefined;

export interface ResolvedRoleSet {
  roles: ResolvedRoles;
  notes: ViewNote[];
}

const scalarText = (raw: Json | undefined): string | undefined =>
  typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
    ? String(raw).trim() || undefined
    : undefined;

const MONEY = /^(-?\d+(?:\.\d+)?)\s+([A-Za-z]{3})$/u;
const CHANNELS = ['online', 'instore', 'both'] as const;

function asLinks(raw: Json | undefined): ViewLink[] | undefined {
  const list = Array.isArray(raw) ? raw : [raw];
  const links: ViewLink[] = [];
  for (const item of list) {
    const url = scalarText(item as Json);
    if (!url || linkKind(url) === 'other') return undefined;
    links.push({ kind: linkKind(url), url });
  }
  return links.length > 0 ? links : undefined;
}

/** A manifest value read as the role's type, or undefined when it is not one. */
function convert(kind: Kind, raw: Json | undefined, currencyCode?: string): RoleScalar | undefined {
  const value = scalarText(raw);
  switch (kind) {
    case 'text':
      return value ? { kind: 'text', text: value } : undefined;
    case 'date':
      return value && !Number.isNaN(Date.parse(value)) ? { kind: 'date', iso: value } : undefined;
    case 'number': {
      if (!value) return undefined;
      const number = Number(value);
      return Number.isFinite(number)
        ? { kind: 'number', number, text: value }
        : { kind: 'text', text: value };
    }
    case 'money': {
      const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
      const amount = scalarText(object?.amount) ?? value;
      const code = scalarText(object?.currencyCode) ?? currencyCode;
      const matched = value ? MONEY.exec(value) : null;
      if (matched)
        return {
          kind: 'money',
          amount: matched[1] as string,
          currencyCode: (matched[2] as string).toUpperCase(),
        };
      return amount && code && Number.isFinite(Number(amount))
        ? { kind: 'money', amount, currencyCode: code.toUpperCase() }
        : undefined;
    }
    case 'location': {
      const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
      const pair = value?.split(',').map((part) => Number(part.trim()));
      const latitude = typeof object?.latitude === 'number' ? object.latitude : pair?.[0];
      const longitude = typeof object?.longitude === 'number' ? object.longitude : pair?.[1];
      return latitude !== undefined &&
        longitude !== undefined &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
        ? { kind: 'location', latitude, longitude }
        : undefined;
    }
    case 'channel': {
      const channel = CHANNELS.find((c) => c === value);
      return channel ? { kind: 'channel', channel } : undefined;
    }
    case 'url':
      return value && /^https:\/\//iu.test(value) ? { kind: 'url', url: value } : undefined;
    case 'app':
      return value && /^https:\/\//iu.test(value) ? { kind: 'app', url: value } : undefined;
    case 'links': {
      const links = asLinks(raw);
      return links ? { kind: 'links', links } : undefined;
    }
  }
}

const extras = (hit: Hit) => ({ ...(hit.label ? { label: hit.label } : {}), fields: hit.fields });

/** Step 1: the manifest source of one role. `null` means the role is deliberately absent. */
function fromManifest(
  role: WalletRole,
  source: WalletRoleSource,
  input: RoleInput,
  evaluate: RoleEvaluator,
  notes: ViewNote[],
): Hit | null {
  const note = (code: ViewNote['code'], message: string) =>
    notes.push({ code, subject: role, message });
  let raw: Json | undefined;
  let from: { path: string; label?: string; currencyCode?: string } | undefined;
  if (source === false) return null;
  if ('field' in source) {
    const field = input.fields.find((f) => f.key === source.field);
    if (!field) {
      note('ROLE_FIELD_MISSING', `No field with key "${source.field}".`);
      return null;
    }
    raw = field.value;
    from = {
      path: field.path,
      ...(field.label ? { label: field.label } : {}),
      ...(field.currencyCode ? { currencyCode: field.currencyCode } : {}),
    };
  } else {
    try {
      raw = evaluate(source.value);
    } catch (error) {
      note('ROLE_EXPR_FAILED', error instanceof Error ? error.message : 'Expression failed.');
      return null;
    }
  }
  if (scalarText(raw) === undefined && (raw === undefined || raw === null || raw === '')) {
    note('ROLE_EMPTY', 'The value is empty for this pass.');
    return null;
  }
  const scalar = convert(ROLE_KINDS[role], raw, from?.currencyCode);
  if (!scalar) {
    note('ROLE_VALUE_INVALID', `The value is not a valid ${ROLE_KINDS[role]} for this role.`);
    return null;
  }
  return {
    scalar,
    ...(from?.label ? { label: from.label } : {}),
    fields: from ? [from.path] : [],
  };
}

/** Resolves every role for one pass. `manifest` is `wallets.roles`. */
export function resolveRoles(
  input: RoleInput,
  manifest: Partial<Record<WalletRole, WalletRoleSource>> | undefined,
  evaluate: RoleEvaluator,
): ResolvedRoleSet {
  const roles: ResolvedRoles = {};
  const notes: ViewNote[] = [];
  for (const role of WALLET_ROLES) {
    const source = manifest?.[role];
    if (source !== undefined) {
      // The author spoke: a failure leaves the role absent instead of falling to a guess.
      const hit = fromManifest(role, source, input, evaluate, notes);
      if (hit) roles[role] = { ...hit.scalar, source: 'manifest', ...extras(hit) };
      continue;
    }
    const rule = ROLE_RULES[role];
    const semantic = rule.semantic?.(input);
    if (semantic) roles[role] = { ...semantic.scalar, source: 'semantics', ...extras(semantic) };
    else {
      const style = rule.style?.(input);
      if (style) roles[role] = { ...style.scalar, source: 'style', ...extras(style) };
    }
  }
  if (!roles.title && input.org.trim())
    roles.title = { kind: 'text', text: input.org.trim(), source: 'style', fields: [] };
  return { roles, notes };
}
