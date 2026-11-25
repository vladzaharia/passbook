/**
 * `resolveWalletView` (architecture 2.1): the materialized Apple pass, in the terms compilers
 * read. Pure: the plan already has bindings, behaviours, local time and normalization applied.
 */

import { inputFields } from '../../shared/issuing/fields.ts';
import type { PlannedPass } from '../build.ts';
import type { PassScope } from '../template/expr.ts';
import { evaluate } from '../template/expr.ts';
import { applyDefaults } from '../template/manifest.ts';
import type { AssetEntry, Personalization, TemplateManifest } from '../types.ts';
import { resolveRoles } from './roles.ts';
import type { ViewNote, WalletPassView } from './types.ts';
import { buildFields, styleOf } from './view-fields.ts';
import { barcodesOf, colorsOf, eventsOf, imagesOf, relevanceOf, urlsOf } from './view-parts.ts';
import { zonedInput, zonedPass } from './zoned-dates.ts';

export interface ViewContext {
  /** Decides `validity.expired`. Compilers get their own clock in `CompileOptions`. */
  now: Date;
  /** The org's zone: a date-time written without an offset is read in it. */
  timeZone: string;
  /** Locales to carry, in preference order. */
  locales: readonly string[];
  /** The pass's personalization: the expression scope of the `wallets` block. */
  input: Personalization;
  pass?: PassScope;
  /** Template assets: where `wallets/**` art and `personalization.json` are looked up. */
  assets?: readonly AssetEntry[];
  /** Public URL of a template image, when it has one. Never asked for a personal file. */
  assetUrl?: (name: string) => string | undefined;
  /** Parsed `.lproj/pass.strings`: locale to key to string. */
  strings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The organization's logo, name and website (settings), for the `appLink` role. */
  appLink?: { name?: string; url?: string; logo?: string };
}

const dateTimeKeys = (manifest: TemplateManifest): Set<string> =>
  new Set(
    inputFields(manifest.inputs)
      .filter((f) => f.format === 'date-time')
      .map((f) => f.key),
  );

export function resolveWalletView(
  plan: PlannedPass,
  manifest: TemplateManifest,
  ctx: ViewContext,
): WalletPassView {
  const pass = zonedPass(plan.passJson, ctx.timeZone);
  const wallets = manifest.wallets;
  const notes: ViewNote[] = [];
  const style = styleOf(pass);
  const fields = buildFields(pass, style);
  const relevance = relevanceOf(pass);
  const barcodes = barcodesOf(pass);

  const scope = {
    input: zonedInput(applyDefaults(manifest, ctx.input), dateTimeKeys(manifest), ctx.timeZone),
    lookups: manifest.lookups ?? {},
    ...(ctx.pass ? { pass: ctx.pass } : {}),
  };
  const resolved = resolveRoles(
    {
      style,
      org: pass.organizationName,
      fields,
      ...(pass.semantics ? { semantics: pass.semantics } : {}),
      barcodes,
      dates: relevance.dates,
      locations: relevance.locations,
      ...(pass.expirationDate ? { expirationDate: pass.expirationDate } : {}),
      ...(ctx.appLink ? { appLink: ctx.appLink } : {}),
    },
    wallets?.roles,
    (expr) => evaluate(expr, scope),
  );
  notes.push(...resolved.notes);
  const images = imagesOf(plan.assets, wallets, ctx, notes);

  const localization: WalletPassView['localization'] = {};
  for (const locale of ctx.locales) {
    const table = ctx.strings?.[locale];
    if (table) localization[locale] = { ...table };
  }
  const expiry = pass.expirationDate ? Date.parse(pass.expirationDate) : Number.NaN;

  return {
    style,
    preferredStyleSchemes: [...(pass.preferredStyleSchemes ?? [])],
    org: pass.organizationName,
    description: pass.description,
    ...(pass.logoText ? { logoText: pass.logoText } : {}),
    fields,
    roles: resolved.roles,
    barcodes,
    colors: colorsOf(pass),
    images,
    relevance,
    validity: {
      ...(pass.expirationDate ? { expirationDate: pass.expirationDate } : {}),
      expired: Number.isFinite(expiry) && expiry <= ctx.now.getTime(),
      voided: pass.voided === true,
    },
    links: {
      featuredActions: (pass.featuredActions ?? []).map((a) => ({
        identifier: a.identifier,
        type: a.type,
        ...(a.url ? { url: a.url } : {}),
      })),
      ...(pass.appLaunchURL ? { appLaunchURL: pass.appLaunchURL } : {}),
      urls: urlsOf(pass),
    },
    events: eventsOf(pass),
    localization,
    sharingProhibited: pass.sharingProhibited === true,
    nfc: pass.nfc !== undefined,
    personalization: ctx.assets?.some((a) => a.name === 'personalization.json') === true,
    messaging: {
      ...(manifest.messaging?.input ? { input: manifest.messaging.input } : {}),
      fields: fields.filter((f) => f.changeMessage !== undefined).map((f) => f.path),
    },
    ...(wallets ? { wallets } : {}),
    notes,
  };
}
