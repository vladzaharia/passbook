/**
 * The state of one compile: what it reports, which Apple fields a native slot already carries,
 * and the text rules (display text is shortened, identity text never is).
 */
import { fitText, lengthItem, sanitizeText, type TextLimit } from '../text.ts';
import type {
  CapabilityId,
  CompileOptions,
  FidelityItem,
  RoleValue,
  Support,
  ViewField,
  WalletPassView,
  WalletRole,
} from '../types.ts';
import { formatWhen } from '../when.ts';
import { DEFAULT_LANGUAGE } from './limits.ts';
import type { GoogleLocalized } from './types.ts';

/** True when the field shows exactly the role's value. */
function sameValue(role: RoleValue, field: ViewField): boolean {
  switch (role.kind) {
    case 'text':
    case 'number':
      return field.text === role.text;
    case 'date':
      return field.text === role.iso;
    case 'money':
      return (
        field.text !== '' &&
        Number(field.text) === Number(role.amount) &&
        (field.currencyCode ?? role.currencyCode) === role.currencyCode
      );
    default:
      return false;
  }
}

export class Ctx {
  readonly items: FidelityItem[] = [];
  /** Apple field paths a native slot carries: they are not repeated as text modules. */
  readonly consumed = new Set<string>();
  /** Roles placed in a native slot. */
  readonly placed = new Set<WalletRole>();
  /** The field a root-semantics role repeats: its label names the role's slot. */
  private readonly twins = new Map<WalletRole, ViewField>();
  /** Identity values that did not fit: the pass is not offered. */
  readonly tooLong: string[] = [];
  private readonly seen = new Set<string>();

  readonly view: WalletPassView;
  readonly options: CompileOptions;
  /** False in the retry after a body went over its size limit. */
  readonly translate: boolean;

  constructor(view: WalletPassView, options: CompileOptions, translate = true) {
    this.view = view;
    this.options = options;
    this.translate = translate;
  }

  note(capability: CapabilityId, path: string, support: Support, message: string): void {
    const key = `${capability}|${path}|${support}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ capability, path, support, message });
  }

  /** The author listed this capability or path in `google.omit`: report it and do not carry it. */
  left(capability: CapabilityId, path = ''): boolean {
    const hit = this.options.omit.some(
      (entry) =>
        entry === capability || (path !== '' && (entry === path || path.endsWith(`.${entry}`))),
    );
    if (hit) this.note(capability, path, 'omitted', 'Left out by the template.');
    return hit;
  }

  role(name: WalletRole): RoleValue | undefined {
    return this.view.roles[name];
  }

  /** The role as plain text, for slots that take a string. */
  roleText(name: WalletRole): string | undefined {
    const role = this.view.roles[name];
    if (!role) return undefined;
    switch (role.kind) {
      case 'text':
        return role.text;
      case 'number':
        return role.text;
      case 'date':
        return formatWhen(role.iso);
      case 'money':
        return `${role.amount} ${role.currencyCode}`;
      case 'channel':
        return role.channel;
      case 'url':
        return role.url;
      default:
        return undefined;
    }
  }

  /**
   * Places a role in a native slot: its Apple fields are not repeated as text. An author-omitted
   * role is dropped with its fields and reported; it returns undefined like an absent role.
   */
  take(name: WalletRole): RoleValue | undefined {
    const role = this.view.roles[name];
    if (!role) return undefined;
    for (const path of role.fields) this.consumed.add(path);
    if (role.fields.length === 0 && role.source === 'semantics') {
      const twin = this.view.fields.find((f) => sameValue(role, f));
      if (twin) {
        this.consumed.add(twin.path);
        this.twins.set(name, twin);
      }
    }
    if (this.left(`role.${name}`, role.fields[0] ?? '')) return undefined;
    this.placed.add(name);
    return role;
  }

  /** The label of the field that supplied the role, or of the field that repeats its value. */
  labelOf(name: WalletRole): string | undefined {
    return this.view.roles[name]?.label ?? this.twins.get(name)?.label;
  }

  /** Display text: shortened to `limit` and reported once per path. */
  display(path: string, raw: string, limit: TextLimit): string {
    const value = sanitizeText(raw);
    const fitted = fitText(value, limit, 'display');
    if (fitted.status === 'ok') return value;
    const item = lengthItem({ path, limit, value });
    if (item) this.note(item.capability, item.path, item.support, item.message);
    return fitted.text;
  }

  /** Identity text: never cut. One that does not fit blocks the pass for Google. */
  identity(path: string, value: string, limit: TextLimit): string {
    if (fitText(value, limit, 'identity').status === 'too-long')
      this.tooLong.push(
        `${path} is longer than ${limit.max} ${limit.unit === 'bytes' ? 'bytes' : 'characters'}.`,
      );
    return value;
  }

  /** The Google `LocalizedString` of display text, with the template's translations. */
  localized(path: string, value: string, limit: TextLimit): GoogleLocalized {
    const text = this.display(path, value, limit);
    const out: GoogleLocalized = { defaultValue: { language: DEFAULT_LANGUAGE, value: text } };
    const translated = this.translations(value, limit);
    if (translated.length > 0) out.translatedValues = translated;
    return out;
  }

  /** `value`'s translations as a `LocalizedString`, when it has any: for the `localized*` twin of a plain field. */
  localizedTwin(value: string, limit: TextLimit): GoogleLocalized | undefined {
    const translatedValues = this.translations(value, limit);
    return translatedValues.length > 0
      ? {
          defaultValue: { language: DEFAULT_LANGUAGE, value: this.display('', value, limit) },
          translatedValues,
        }
      : undefined;
  }

  /** The translations of `value` (an Apple string key), by locale, shortened like the default. */
  translations(value: string, limit: TextLimit): { language: string; value: string }[] {
    if (!this.translate) return [];
    const out: { language: string; value: string }[] = [];
    for (const locale of Object.keys(this.view.localization).sort()) {
      const language = locale.replace(/_/gu, '-');
      const found = this.view.localization[locale]?.[value];
      if (language === DEFAULT_LANGUAGE || found === undefined || found === '') continue;
      const fitted = fitText(found, limit, 'display');
      out.push({ language, value: fitted.text });
    }
    return out;
  }
}
