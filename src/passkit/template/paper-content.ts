/**
 * What a printed ticket says, from a built pass and its template. Renderer-neutral: dates are ISO
 * strings plus a zone (format them with paper-format.ts), colours are `#rrggbb`, and nothing here
 * knows about CSS or PDF. Roles come from the shared resolver (wallets/roles.ts), so a ticket reads
 * like the wallet copies. The scan code, the lookup value and barcode messages are never read: the
 * code on paper is the print code, added by the page.
 */
import { PAPER_COPY } from '../../shared/copy/print.ts';
import type { Expr, PassJson, Personalization, TemplateManifest } from '../types.ts';
import type { RoleValue } from '../wallets/types.ts';
import { buildFields, styleOf } from '../wallets/view-fields.ts';
import { relevanceOf } from '../wallets/view-parts.ts';
import { ExprError, evaluate } from './expr.ts';
import { applyDefaults } from './manifest.ts';
import { lookupIsPublic, type PaperDesign, type PaperInk, type PaperKind } from './paper.ts';
import { checkInOnce, declaredTimes, printZone } from './paper-declared.ts';
import { type PaperColors, paperInk } from './paper-ink.ts';
import { ISO, type Kinded, kindContent, kindOf } from './paper-kinds.ts';
import { dedupeAddress, idFlagged, paperRoles } from './paper-roles.ts';

export type PaperArt = 'artwork' | 'background' | 'thumbnail' | 'strip';
export interface PaperFact {
  label: string;
  text: string;
}

export interface PaperContent {
  brand: string;
  kind: PaperKind;
  /** Resolved: `mono` when the design asks for it or the greyscale check fails. */
  ink: PaperInk;
  colors: PaperColors;
  /** The art slot to draw in the band, when the template has one. */
  art?: PaperArt;
  /** The template has a logo; it always sits on a plate in the pass colour. */
  logo: boolean;
  title: string;
  /** The class word above the title: "Event ticket", "Day pass". */
  kicker: string;
  /** "Ticket", "Pass": what the phone copy is called in the one-ticket line. */
  noun: string;
  /** The template's check-in admits once; otherwise the print and the phone both keep working. */
  once: boolean;
  start?: string;
  end?: string;
  doors?: string;
  validFrom?: string;
  validUntil?: string;
  /** IANA name or `+hh:mm`: the zone of the start, or of every time when `zoneNamed`. */
  zone?: string;
  /** A named zone (template input or the org's): every time prints in it. Else each keeps its offset. */
  zoneNamed: boolean;
  /** Venue, or the home club for a membership. */
  venue?: string;
  address?: string;
  room?: string;
  directions?: string;
  holder?: string;
  type?: string;
  seat?: { section?: string; row?: string; seat?: string };
  /** Up to three boxes on the holder panel: seat parts, or class facts. */
  facts: PaperFact[];
  items?: string[];
  /** Permit zone and plate, coupon offer, pickup name. */
  hero?: { zone?: string; plate?: string; offer?: string; offerNote?: string; name?: string };
  bring: string[];
  help: string[];
  terms?: string;
  /** Fields the design names, after the credential guards. */
  extras: { label?: string; text: string }[];
}

export interface PaperContentInput {
  passJson: PassJson;
  manifest: Pick<
    TemplateManifest,
    'wallets' | 'behaviors' | 'inputs' | 'lookups' | 'scan' | 'display' | 'name'
  >;
  personalization: Personalization;
  design: PaperDesign;
  /** The holder's name when the pass has one; never an email address. */
  holderName?: string | null;
  /** The pass's own scan code: a field equal to it is never printed. */
  scanCode?: string | null;
  /** The org's time zone: times written in UTC read in it. */
  orgTimeZone?: string | null;
  /** Image slots the template ships (`logo`, `artwork`, ...). Absent: the logo is assumed, no art. */
  images?: readonly string[];
}

const text = (v: RoleValue | undefined): string | undefined => {
  if (!v) return undefined;
  if (v.kind === 'text' || v.kind === 'number') return v.text;
  return undefined;
};

const plain = (v: unknown): string | undefined => {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim() || undefined;
  return undefined;
};

const ART_ORDER: Record<PaperKind, PaperArt[]> = {
  coupon: ['strip', 'artwork', 'background'],
  admission: ['artwork', 'background', 'thumbnail', 'strip'],
  // Never the thumbnail: on an ID card it is the member's photo.
  membership: ['artwork', 'background'],
  permit: [],
  pickup: [],
};
const MAX_HELP = 3;
const MAX_BRING = 4;

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
  const roles = paperRoles(
    { style, org: passJson.organizationName, fields, passJson, relevance },
    manifest.wallets?.roles,
    evalExpr,
  );
  const evalText = (e: Expr): string | undefined => {
    try {
      return plain(evalExpr(e));
    } catch (error) {
      // A bad expression is the author's data problem: nothing printed. Anything else is a bug.
      if (!(error instanceof ExprError)) throw error;
      return undefined;
    }
  };
  const lookup = (manifest.scan as { lookup?: { input?: unknown } } | undefined)?.lookup?.input;
  const lookupValue = typeof lookup === 'string' ? plain(input.personalization[lookup]) : undefined;
  // A template that declares its lookup public may print it (a permit's plate).
  const publicLookup = lookupIsPublic(manifest);
  const credentials = new Set<string>(
    [
      passJson.serialNumber,
      input.scanCode,
      publicLookup ? undefined : lookupValue,
      ...[...(passJson.barcodes ?? []), ...(passJson.barcode ? [passJson.barcode] : [])].flatMap(
        (b) => [b.message, b.altText],
      ),
    ]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim()),
  );
  // The barcode's alt text is often the lookup value itself; public lets that value through.
  if (
    publicLookup &&
    lookupValue &&
    lookupValue !== input.scanCode &&
    lookupValue !== passJson.serialNumber
  )
    credentials.delete(lookupValue);
  const semantics = (passJson.semantics ?? {}) as Record<string, unknown>;
  const field = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const f = fields.find((x) => x.key === key);
      const value = f?.text.trim();
      if (value && !credentials.has(value)) return value;
    }
    return undefined;
  };
  const tzInput = Object.entries(manifest.inputs?.properties ?? {}).find(
    ([, schema]) => (schema as Record<string, unknown>)['x-timeZone'] === true,
  )?.[0];
  const named = tzInput ? plain(input.personalization[tzInput]) : undefined;

  const kind: PaperKind = design.kind ?? kindOf(manifest, style, roles);
  const ctx: Kinded = {
    kind,
    roles,
    field,
    semantics,
    holderName: input.holderName ?? undefined,
    publicLookup: publicLookup ? lookupValue : undefined,
    declared: declaredTimes(manifest, input.personalization),
  };
  const parts = kindContent(ctx);
  const venue = parts.venue;
  const holder = parts.holder;
  // A terms expression of the design is the author's word, even when it comes out empty.
  const terms =
    design.terms === undefined
      ? (text(roles.finePrint) ?? (kind === 'coupon' ? field('fine') : field('terms', 'fine')))
      : evalText(design.terms);
  const extras = design.fields.flatMap((ref) => {
    const key = ref.split('.').at(-1);
    const f = fields.find((x) => x.path === ref || x.key === key);
    const value = f?.text.trim();
    // Never a second door credential: a field equal to the lookup value, a barcode message, its
    // alt text, the scan code or the serial.
    if (!f || !value || credentials.has(value)) return [];
    return [{ ...(f.label ? { label: f.label } : {}), text: value }];
  });
  const mono = design.ink === 'mono';
  const { colour, colors } = paperInk(passJson);
  const have = new Set(input.images);
  const art = input.images ? ART_ORDER[kind].find((slot) => have.has(slot)) : undefined;

  const lead = text(roles.title);
  const title = parts.title ?? (lead && !ISO.test(lead) ? lead : undefined) ?? passJson.description;
  const label = parts.kicker ?? manifest.name;
  // The permit blueprint's own label is "Permit"; on paper it says what it is.
  const kicker = (kind === 'permit' && label === 'Permit' ? 'Parking permit' : label) ?? title;
  const noun = kind === 'admission' && !/pass|card/i.test(kicker) ? 'ticket' : 'pass';
  const idRequired = idFlagged(manifest, input.personalization);
  const bring = [
    PAPER_COPY.bringDefault(noun),
    ...(idRequired && holder ? [PAPER_COPY.bringId(holder)] : []),
    ...(design.bring === undefined ? [] : (evalText(design.bring) ?? '').split('\n')),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BRING);
  const helpLinks =
    roles.support?.kind === 'links' ? roles.support.links.map((l) => l.text ?? l.url) : [];
  const help = [
    ...new Set(
      [field('contact'), field('phone'), field('support'), field('site', 'website'), ...helpLinks]
        .filter((v): v is string => Boolean(v))
        .map((v) => v.replace(/^(?:mailto:|tel:)/, '')),
    ),
  ].slice(0, MAX_HELP);
  const { zone, zoneNamed } = printZone(
    { start: parts.start, end: parts.end, doors: parts.doors },
    [parts.validUntil, parts.validFrom],
    named,
    input.orgTimeZone,
  );
  const room = parts.room && parts.room !== venue ? parts.room : undefined;
  const address = dedupeAddress(room, dedupeAddress(venue, parts.address));
  return {
    brand: passJson.organizationName,
    kind,
    ink: mono || !colour ? 'mono' : 'colour',
    colors,
    ...(art ? { art } : {}),
    logo: input.images ? have.has('logo') : true,
    title,
    kicker,
    noun,
    once: checkInOnce(manifest),
    ...(parts.start ? { start: parts.start } : {}),
    ...(parts.end ? { end: parts.end } : {}),
    ...(parts.doors ? { doors: parts.doors } : {}),
    ...(parts.validFrom ? { validFrom: parts.validFrom } : {}),
    ...(parts.validUntil ? { validUntil: parts.validUntil } : {}),
    ...(zone ? { zone } : {}),
    zoneNamed,
    ...(venue ? { venue } : {}),
    ...(address ? { address } : {}),
    ...(room ? { room } : {}),
    ...(parts.directions ? { directions: parts.directions } : {}),
    ...(holder ? { holder } : {}),
    ...(parts.type ? { type: parts.type } : {}),
    ...(parts.seat ? { seat: parts.seat } : {}),
    facts: parts.facts.slice(0, 3),
    ...(parts.items?.length ? { items: parts.items } : {}),
    ...(parts.hero ? { hero: parts.hero } : {}),
    bring,
    help,
    ...(terms ? { terms } : {}),
    extras,
  };
}
