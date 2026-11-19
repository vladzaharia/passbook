/**
 * What a printed ticket says, from a built pass and its template: event, date, venue, holder, type,
 * seat, terms, brand and any fields the design names. Roles come from the shared resolver
 * (wallets/roles.ts), so a ticket reads like the wallet copies. The scan code, the lookup value
 * and barcode messages are never read: the code on paper is the print code, added by the page.
 */
import { placeDate } from '../../shared/pass-view/semantic.ts';
import type { Expr, PassJson, Personalization, TemplateManifest } from '../types.ts';
import { resolveRoles } from '../wallets/roles.ts';
import type { ResolvedRoles, RoleValue } from '../wallets/types.ts';
import { buildFields, styleOf } from '../wallets/view-fields.ts';
import { relevanceOf } from '../wallets/view-parts.ts';
import { ExprError, evaluate } from './expr.ts';
import { applyDefaults } from './manifest.ts';
import type { PaperDesign } from './paper.ts';

export interface PaperContent {
  brand: string;
  event: string;
  date?: string;
  venue?: string;
  holder?: string;
  type?: string;
  seat?: string;
  terms?: string;
  extras: { label?: string; text: string }[];
}

export interface PaperContentInput {
  passJson: PassJson;
  manifest: Pick<TemplateManifest, 'wallets' | 'inputs' | 'lookups' | 'scan'>;
  personalization: Personalization;
  design: PaperDesign;
  /** The holder's name when the pass has one; never an email address. */
  holderName?: string | null;
  /** The pass's own scan code: a field equal to it is never printed. */
  scanCode?: string | null;
}

const text = (v: RoleValue | undefined): string | undefined => {
  if (!v) return undefined;
  if (v.kind === 'text' || v.kind === 'number') return v.text;
  return undefined;
};

function when(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = placeDate(iso, { locale: 'en', now: new Date(0) }, { local: true });
  if (!at) return undefined;
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(at.timeZone ? { timeZone: at.timeZone } : {}),
  }).format(at.date);
}

function seatOf(roles: ResolvedRoles): string | undefined {
  const parts = [
    text(roles.section) && `Section ${text(roles.section)}`,
    text(roles.row) && `Row ${text(roles.row)}`,
    text(roles.seat) && `Seat ${text(roles.seat)}`,
    text(roles.gate) && `Gate ${text(roles.gate)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

const plain = (v: unknown): string | undefined => {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim() || undefined;
  return undefined;
};

/** The ticket's words. Pure; the same pass and design always give the same content. */
export function paperContent(input: PaperContentInput): PaperContent {
  const { passJson, manifest, design } = input;
  const style = styleOf(passJson);
  const fields = buildFields(passJson, style);
  const relevance = relevanceOf(passJson);
  // No `pass` scope: an expression that asks for the scan code gets nothing.
  const scope = {
    input: applyDefaults(
      {
        ...manifest,
        inputs: manifest.inputs ?? { type: 'object', properties: {} },
      } as TemplateManifest,
      input.personalization,
    ),
    lookups: manifest.lookups ?? {},
  };
  const evalExpr = (e: Expr) => evaluate(e, scope);
  const { roles } = resolveRoles(
    {
      style,
      org: passJson.organizationName,
      fields,
      ...(passJson.semantics ? { semantics: passJson.semantics } : {}),
      barcodes: [],
      dates: relevance.dates,
      locations: relevance.locations,
    },
    manifest.wallets?.roles,
    evalExpr,
  );
  const start = roles.eventStart?.kind === 'date' ? roles.eventStart.iso : undefined;
  const venue = [text(roles.venueName), text(roles.venueAddress)].filter(Boolean).join(', ');
  let terms: string | undefined;
  if (design.terms !== undefined) {
    try {
      terms = plain(evalExpr(design.terms));
    } catch (error) {
      // A bad expression is the author's data problem: no terms. Anything else is a bug.
      if (!(error instanceof ExprError)) throw error;
      terms = undefined;
    }
  }
  terms ??= text(roles.finePrint);
  const lookup = (manifest.scan as { lookup?: { input?: unknown } } | undefined)?.lookup?.input;
  const credentials = new Set<string>(
    [
      passJson.serialNumber,
      input.scanCode,
      ...[...(passJson.barcodes ?? []), ...(passJson.barcode ? [passJson.barcode] : [])].flatMap(
        (b) => [b.message, b.altText],
      ),
    ]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim()),
  );
  const extras = design.fields.flatMap((ref) => {
    const key = ref.split('.').at(-1);
    const f = fields.find((x) => x.path === ref || x.key === key);
    if (!f?.text.trim()) return [];
    const value = f.text.trim();
    if (typeof lookup === 'string' && plain(input.personalization[lookup]) === value) return [];
    // Never a second door credential: a field that equals a barcode message, its alt text or the serial.
    if (credentials.has(value)) return [];
    return [{ ...(f.label ? { label: f.label } : {}), text: f.text.trim() }];
  });
  const holder =
    text(roles.ticketHolder) ?? text(roles.memberName) ?? input.holderName ?? undefined;
  const seat = seatOf(roles);
  const admission = (passJson.semantics as Record<string, unknown> | undefined)?.admissionLevel;
  const type = text(roles.tier) ?? plain(admission);
  const date = when(start);
  return {
    brand: passJson.organizationName,
    event: text(roles.eventName) ?? text(roles.title) ?? passJson.description,
    ...(date ? { date } : {}),
    ...(venue ? { venue } : {}),
    ...(holder ? { holder } : {}),
    ...(type ? { type } : {}),
    ...(seat ? { seat } : {}),
    ...(terms ? { terms } : {}),
    extras,
  } as PaperContent;
}
