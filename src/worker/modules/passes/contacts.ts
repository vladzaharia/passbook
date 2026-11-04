import { FIELD_GROUPS } from '../../../passkit/schema/constants.ts';
import { PASS_STYLES, type PassJson } from '../../../passkit/types.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { getOrgSettings } from '../settings/service.ts';

export interface BackContacts {
  /** The org's support email and URL, one per line; null when it has none. */
  contact: string | null;
  /** Platform support, so holders can reach the signer. */
  passService: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? v : null);
const safeMail = (v: unknown) => (typeof v === 'string' && EMAIL.test(v) ? v : null);

/** "PassBook · support@passbook.mobile" and the site; just the site when no address is set. */
export function passServiceText(env: Parameters<typeof baseUrl>[0]): string {
  const email = platformSupportEmail(env);
  return [email ? `PassBook · ${email}` : null, baseUrl(env)].filter(Boolean).join('\n');
}

/** Org settings win over the legacy branding fields. */
export async function backContactsFor(
  ctx: ServiceContext,
  orgId: string,
  branding: unknown,
): Promise<BackContacts> {
  const settings = await getOrgSettings(ctx, orgId);
  const legacy = (branding ?? {}) as { supportEmail?: unknown; supportUrl?: unknown };
  const lines = [
    safeMail(settings['support.email'] ?? legacy.supportEmail),
    safeUrl(settings['support.url'] ?? legacy.supportUrl),
  ].filter((v): v is string => Boolean(v));
  return { contact: lines.length ? lines.join('\n') : null, passService: passServiceText(ctx.env) };
}

const SLOT = /^(contact|pass-service)(-poster)?$/;

/**
 * Fills the empty `contact` and `pass-service` back fields a template declares (starters do) and
 * removes the ones without a value. Fields with their own value, and other keys, stay as they are.
 */
export function withBackContacts(base: PassJson, contacts: BackContacts): PassJson {
  const pass = structuredClone(base);
  for (const style of PASS_STYLES) {
    const dict = pass[style] as Record<string, unknown> | undefined;
    if (!dict) continue;
    for (const group of FIELD_GROUPS) {
      const list = dict[group];
      if (!Array.isArray(list)) continue;
      dict[group] = list.flatMap((field: { key?: string; value?: unknown }) => {
        const slot = SLOT.exec(typeof field?.key === 'string' ? field.key : '')?.[1];
        if (!slot || field.value !== '') return [field];
        const value = slot === 'contact' ? contacts.contact : contacts.passService;
        return value ? [{ ...field, value }] : [];
      });
    }
  }
  return pass;
}
