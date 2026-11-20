/**
 * Everything that has no native slot goes into labelled text modules in Apple's front-to-back
 * order (architecture 3.3 step 2), with links in the links module. Google shows 10 modules: past
 * that the rest are folded into the last one as labelled lines. Links past 10 are folded the same way.
 */

import { fitText } from '../text.ts';
import {
  type CapabilityId,
  type ViewField,
  type ViewLink,
  WALLET_ROLES,
  type WalletRole,
} from '../types.ts';
import { formatWhen } from '../when.ts';
import type { Ctx } from './ctx.ts';
import { DEFAULT_LANGUAGE, MAX_MODULES, MAX_URIS, TEXT } from './limits.ts';
import type {
  GoogleLinksModule,
  GoogleLinkUri,
  GoogleLocalized,
  GoogleTextModule,
} from './types.ts';
import { humanize, moduleId } from './values.ts';

/** Roles that never become text: the app link is Samsung's, links go to the links module. */
const NOT_TEXT = new Set<WalletRole>(['appLink', 'support']);
const ROLE_LABEL: Partial<Record<WalletRole, string>> = {
  eventName: 'Event',
  eventStart: 'Starts',
  eventEnd: 'Ends',
  doorsOpen: 'Doors open',
  venueName: 'Venue',
  venueAddress: 'Address',
  seat: 'Seat',
  row: 'Row',
  section: 'Section',
  gate: 'Gate',
  ticketHolder: 'Ticket holder',
  ticketNumber: 'Ticket number',
  confirmationCode: 'Confirmation code',
  eventId: 'Event ID',
  memberId: 'Member ID',
  memberName: 'Member',
  tier: 'Tier',
  points: 'Points',
  balance: 'Balance',
  giftCardNumber: 'Card number',
  giftCardPin: 'PIN',
  offerTitle: 'Offer',
  offerDetails: 'Details',
  finePrint: 'Terms',
  redemptionChannel: 'Redeem',
  title: 'Title',
  subtitle: 'Subtitle',
  validFrom: 'Valid from',
  validUntil: 'Valid until',
};
const LINK_LABEL = { tel: 'Phone', mailto: 'Email', web: 'Website', other: 'Link' } as const;

export interface ModuleOptions {
  /** Types that show one event and list the rest as text. */
  events: boolean;
}

const localizedOf = (ctx: Ctx, text: string): GoogleLocalized | undefined => {
  const translatedValues = ctx.translations(text, TEXT.body);
  return translatedValues.length > 0
    ? { defaultValue: { language: DEFAULT_LANGUAGE, value: text }, translatedValues }
    : undefined;
};

function bodyOf(field: ViewField): string {
  if ((field.dateStyle || field.timeStyle) && typeof field.value === 'string')
    return formatWhen(field.value, field.dateStyle, field.timeStyle);
  const numeric = field.currencyCode !== undefined && Number.isFinite(Number(field.text));
  return numeric ? `${field.text} ${field.currencyCode}` : field.text;
}

class Modules {
  readonly text: GoogleTextModule[] = [];
  readonly uris: GoogleLinkUri[] = [];
  readonly emitted = new Set<string>();
  /** What each module said before dates were written out: a role's ISO value matches it. */
  readonly raw = new Set<string>();
  /** The last module's full body and path, so overflow can be appended to it. */
  private tail: { raw: string; path: string; langs: Map<string, string> } | undefined;

  private readonly ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  full(): boolean {
    return this.text.length >= MAX_MODULES;
  }

  add(id: string, label: string | undefined, body: string, path: string): GoogleTextModule {
    const { ctx } = this;
    const module: GoogleTextModule = { id: moduleId(id), body: ctx.display(path, body, TEXT.body) };
    if (label) module.header = ctx.display(`${path}.label`, label, TEXT.title);
    if (ctx.translate) {
      const localizedBody = localizedOf(ctx, body);
      const localizedHeader = label ? localizedOf(ctx, label) : undefined;
      if (localizedBody) module.localizedBody = localizedBody;
      if (localizedHeader) module.localizedHeader = localizedHeader;
    }
    this.text.push(module);
    this.tail = {
      raw: body,
      path,
      langs: new Map(
        (module.localizedBody?.translatedValues ?? []).map((t) => [t.language, t.value]),
      ),
    };
    return module;
  }

  /** Google shows 10 modules: the rest become labelled lines of the last one, and the report says so. */
  fold(capability: CapabilityId, path: string, label: string | undefined, body: string): void {
    const { ctx, tail } = this;
    const last = this.text[this.text.length - 1];
    if (!last || !tail) {
      this.add(`overflow.${path}`, label, body, path);
      ctx.note(
        capability,
        path,
        'difference',
        `Google shows ${MAX_URIS} links: carried as a text module.`,
      );
      return;
    }
    const line = (l: string | undefined, b: string) => `\n${l ? `${l}: ` : ''}${b}`;
    if (ctx.translate) {
      const bodies = new Map(ctx.translations(body, TEXT.body).map((t) => [t.language, t.value]));
      const labels = new Map(
        (label ? ctx.translations(label, TEXT.title) : []).map((t) => [t.language, t.value]),
      );
      for (const language of new Set([...tail.langs.keys(), ...bodies.keys(), ...labels.keys()]))
        tail.langs.set(
          language,
          (tail.langs.get(language) ?? tail.raw) +
            line(labels.get(language) ?? label, bodies.get(language) ?? body),
        );
    }
    tail.raw += line(label, body);
    last.body = ctx.display(tail.path, tail.raw, TEXT.long);
    if (tail.langs.size > 0)
      last.localizedBody = {
        defaultValue: { language: DEFAULT_LANGUAGE, value: last.body },
        translatedValues: [...tail.langs].map(([language, value]) => ({
          language,
          value: fitText(value, TEXT.long, 'display').text,
        })),
      };
    ctx.note(
      capability,
      path,
      'difference',
      `Google shows ${MAX_MODULES} text modules: carried as a line of "${last.header ?? last.id}".`,
    );
  }

  link(link: ViewLink, description: string, path: string): void {
    if (this.uris.some((u) => u.uri === link.url)) return;
    if (this.uris.length >= MAX_URIS) {
      this.fold('field.link', path, link.text ?? description, link.url);
      return;
    }
    this.uris.push({
      id: `link.${this.uris.length}`,
      uri: link.url,
      description: this.ctx.display(path, link.text ?? description, TEXT.title) || link.url,
    });
  }
}

function fieldModules(ctx: Ctx, m: Modules): void {
  for (const f of ctx.view.fields) {
    if (ctx.consumed.has(f.path) || f.text === '') continue;
    const capability = `field.${f.group}` as const;
    if (ctx.left(capability, f.path)) continue;
    if (m.full()) {
      m.fold(capability, f.path, f.label, bodyOf(f));
      for (const link of f.links) m.link(link, f.label ?? f.text, f.path);
      continue;
    }
    m.add(f.path, f.label, bodyOf(f), f.path);
    m.emitted.add(f.path);
    m.raw.add(f.text);
    ctx.note(capability, f.path, 'text', 'Carried as a text module.');
    if (f.dateStyle || f.timeStyle)
      ctx.note(
        capability,
        f.path,
        'difference',
        'Written out in English: Google has no date style.',
      );
    else if (f.numberStyle)
      ctx.note(capability, f.path, 'difference', 'Shown as written: Google has no number style.');
    for (const link of f.links) m.link(link, f.label ?? f.text, f.path);
  }
}

/** The role as the field text it would match: a date by its ISO value, anything else as text. */
const rawOf = (ctx: Ctx, role: WalletRole): string | undefined => {
  const value = ctx.role(role);
  return value?.kind === 'date' ? value.iso : ctx.roleText(role);
};

/** Everything the pass already says, so a role that repeats it adds nothing. */
const carried = (ctx: Ctx, m: Modules): Set<string | undefined> =>
  new Set([
    ...m.text.map((x) => x.body),
    ...m.raw,
    ...[...ctx.placed].flatMap((r) => [ctx.roleText(r), rawOf(ctx, r)]),
  ]);

/** Roles with no native slot: a field-backed one is already a module; one from an expression becomes one. */
function roleModules(ctx: Ctx, m: Modules): void {
  for (const role of WALLET_ROLES) {
    const value = ctx.role(role);
    if (!value || ctx.placed.has(role) || NOT_TEXT.has(role)) continue;
    const path = value.fields[0] ?? '';
    if (value.fields.length > 0) {
      if (value.fields.some((p) => m.emitted.has(p)))
        ctx.note(`role.${role}`, path, 'text', 'Carried as a text module.');
      continue;
    }
    const body = ctx.roleText(role);
    if (value.source === 'style' || body === undefined || ctx.left(`role.${role}`)) continue;
    if (carried(ctx, m).has(body) || carried(ctx, m).has(rawOf(ctx, role))) {
      ctx.note(`role.${role}`, '', 'text', 'Carried elsewhere on the pass.');
      continue;
    }
    if (m.full()) {
      m.fold(`role.${role}`, '', value.label ?? ROLE_LABEL[role], body);
      continue;
    }
    m.add(`role.${role}`, value.label ?? ROLE_LABEL[role], body, `role.${role}`);
    ctx.note(`role.${role}`, '', 'text', 'Carried as a text module.');
  }
}

function upcoming(ctx: Ctx, m: Modules, options: ModuleOptions): void {
  const { events } = ctx.view;
  if (events.length === 0) return;
  if (!options.events) {
    ctx.note('upcoming.multi', 'events', 'omitted', 'This Google type shows one event.');
    return;
  }
  if (ctx.left('upcoming.multi', 'events')) return;
  if (m.full()) {
    const lines = events.map((e) => (e.date ? `${e.name}: ${formatWhen(e.date)}` : e.name));
    m.fold('upcoming.multi', 'events', 'Upcoming', lines.join('\n'));
    return;
  }
  const lines = events.map((e) => (e.date ? `${e.name}: ${formatWhen(e.date)}` : e.name));
  m.add('upcoming', 'Upcoming', lines.join('\n'), 'events');
  ctx.note('upcoming.multi', 'events', 'text', 'The events are listed as text.');
}

function extraLinks(ctx: Ctx, m: Modules): void {
  const support = ctx.role('support');
  if (support?.kind === 'links')
    for (const link of support.links) m.link(link, LINK_LABEL[link.kind], 'role.support');
  if (ctx.left('links.featured', 'links')) return;
  const { links } = ctx.view;
  for (const action of links.featuredActions)
    if (action.url)
      m.link({ kind: 'web', url: action.url }, humanize(action.type), `links.${action.identifier}`);
  for (const [key, url] of Object.entries(links.urls))
    m.link({ kind: 'web', url }, humanize(key), `links.${key}`);
}

export function moduleBodies(
  ctx: Ctx,
  options: ModuleOptions,
): { textModulesData?: GoogleTextModule[]; linksModuleData?: GoogleLinksModule } {
  const m = new Modules(ctx);
  fieldModules(ctx, m);
  roleModules(ctx, m);
  upcoming(ctx, m, options);
  extraLinks(ctx, m);
  return {
    ...(m.text.length > 0 ? { textModulesData: m.text } : {}),
    ...(m.uris.length > 0 ? { linksModuleData: { uris: m.uris } } : {}),
  };
}
