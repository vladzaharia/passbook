import { levelState } from '@/shared/channels.ts';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import type { BrandMark } from '@/shared/contracts/orgs.ts';
import type { PassSetup, PassSetupPatch } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { orgSetupChecks, type SetupFacts } from '@/shared/org-setup-checks.ts';
import { HEX } from '../orgs/branding.ts';

/** A PNG staged by POST /brand-assets, with a local URL to draw it before the save commits it. */
export interface StagedImage {
  sha: string;
  /** What the upload answered; the save names it with the sha, which differs when an @2x was sent. */
  version?: string;
  w: number;
  h: number;
  url: string;
}
export type ImageSlot = 'logo' | 'icon' | 'webLogo';

/** What the admin has changed on the page; a key left out follows the saved view. */
export interface Draft {
  name?: string;
  /** A staged image, or null to clear the slot. */
  images?: Partial<Record<ImageSlot, StagedImage | null>>;
  sameAsLogo?: boolean;
  background?: string;
  foreground?: string;
  label?: string;
  logoHasName?: boolean;
  accent?: string;
  mark?: BrandMark;
  supportEmail?: string;
  supportUrl?: string;
  fromName?: string;
  buddy?: boolean;
  channels?: Partial<Record<Channel, 'allowed' | 'blocked'>>;
}

/** The form values a view holds; the draft's keys replace them. */
export interface Values {
  name: string;
  background: string;
  foreground: string;
  label: string;
  logoHasName: boolean;
  accent: string;
  mark: BrandMark;
  supportEmail: string;
  supportUrl: string;
  fromName: string;
  buddy: boolean;
  sameAsLogo: boolean;
}

export function valuesOf(view: PassSetup): Values {
  const b = view.brand;
  const c = b.passColors.value;
  return {
    name: b.name.value ?? '',
    background: c?.background ?? '',
    foreground: c?.foreground ?? '',
    label: c?.label ?? '',
    logoHasName: b.logoHasName.value ?? false,
    accent: b.accent.source === 'org' ? (b.accent.value ?? '') : '',
    mark: b.mark.allowed.includes(b.mark.chosen) ? b.mark.chosen : b.mark.effective,
    supportEmail: b.support.email.source === 'org' ? (b.support.email.value ?? '') : '',
    supportUrl: b.support.url.source === 'org' ? (b.support.url.value ?? '') : '',
    fromName: b.email.fromName.source === 'org' ? (b.email.fromName.value ?? '') : '',
    buddy: b.email.buddy,
    sameAsLogo: b.webLogo.sameAsLogo,
  };
}

/** The values on screen: the view's, with the draft laid over. */
export const shownValues = (view: PassSetup, draft: Draft): Values => ({
  ...valuesOf(view),
  ...Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => v !== undefined && k !== 'images' && k !== 'channels'),
  ),
});

export function colorErrors(v: Pick<Values, 'background' | 'foreground' | 'label'>) {
  const out: Partial<Record<'background' | 'foreground' | 'label', string>> = {};
  const any = [v.background, v.foreground, v.label].some(Boolean);
  if (!any) return out;
  for (const key of ['background', 'foreground', 'label'] as const)
    if (!HEX.test(v[key]))
      out[key] = v[key] ? PASS_SETUP_COPY.brand.colourError : PASS_SETUP_COPY.brand.colourSet;
  return out;
}

export function draftErrors(view: PassSetup, draft: Draft): Record<string, string> {
  const v = shownValues(view, draft);
  const errors: Record<string, string> = { ...colorErrors(v) };
  if (!v.name.trim()) errors.name = 'Required.';
  if (v.accent && !HEX.test(v.accent)) errors.accent = PASS_SETUP_COPY.brand.colourError;
  return errors;
}

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** The PATCH body for the draft: only what differs from the view. Empty means nothing to save. */
export function draftPatch(view: PassSetup, draft: Draft): PassSetupPatch | null {
  const base = valuesOf(view);
  const v = shownValues(view, draft);
  const brand: NonNullable<PassSetupPatch['brand']> = {};
  if (v.name.trim() !== base.name) brand.name = v.name.trim();
  for (const slot of ['logo', 'icon', 'webLogo'] as const) {
    const img = draft.images?.[slot];
    if (img !== undefined) brand[slot] = img === null ? null : stagedRef(img);
  }
  if (v.sameAsLogo !== base.sameAsLogo) brand.webLogoSameAsLogo = v.sameAsLogo;
  const colors = [v.background, v.foreground, v.label];
  if (colors.join() !== [base.background, base.foreground, base.label].join()) {
    if (colors.every((c) => c === '')) brand.passColors = null;
    else if (colors.every((c) => HEX.test(c)))
      brand.passColors = { background: v.background, foreground: v.foreground, label: v.label };
  }
  if (v.logoHasName !== base.logoHasName) brand.logoHasName = v.logoHasName;
  if (v.accent !== base.accent && (v.accent === '' || HEX.test(v.accent)))
    brand.accent = orNull(v.accent);
  if (v.mark !== base.mark) brand.mark = v.mark;
  const support: NonNullable<PassSetupPatch['brand']>['support'] = {};
  if (v.supportEmail !== base.supportEmail) support.email = orNull(v.supportEmail);
  if (v.supportUrl !== base.supportUrl) support.url = orNull(v.supportUrl);
  if (Object.keys(support).length) brand.support = support;
  const email: NonNullable<PassSetupPatch['brand']>['email'] = {};
  if (v.fromName !== base.fromName) email.fromName = orNull(v.fromName);
  if (v.buddy !== base.buddy) email.buddy = v.buddy;
  if (Object.keys(email).length) brand.email = email;
  const channels: NonNullable<PassSetupPatch['channels']> = {};
  for (const c of CHANNELS) {
    const want = draft.channels?.[c];
    if (want && (want === 'allowed') !== view.channels[c].allowed) channels[c] = want;
  }
  const hasBrand = Object.keys(brand).length > 0;
  const hasChannels = Object.keys(channels).length > 0;
  if (!hasBrand && !hasChannels) return null;
  return {
    expectedRevision: view.revision,
    ...(hasBrand ? { brand } : {}),
    ...(hasChannels ? { channels } : {}),
  };
}

/** How many edits the save bar counts: one per field, the three colours as one. */
export function changeCount(patch: PassSetupPatch | null): number {
  if (!patch) return 0;
  const b = patch.brand ?? {};
  return (
    Object.keys(b).filter((k) => k !== 'support' && k !== 'email').length +
    Object.keys(b.support ?? {}).length +
    Object.keys(b.email ?? {}).length +
    Object.keys(patch.channels ?? {}).length
  );
}

/** How a save names a staged upload. */
export const stagedRef = (img: Pick<StagedImage, 'sha' | 'version'>) =>
  img.version ? { sha: img.sha, version: img.version } : { sha: img.sha };

const imageValue = (img: StagedImage) => ({ sha: img.sha, w: img.w, h: img.h });

/** The view as it would read after the save, for the checks, the preview and the locked tabs. */
export function facts(view: PassSetup, draft: Draft): SetupFacts {
  const { checks: _checks, ...rest } = view;
  const v = shownValues(view, draft);
  const b = rest.brand;
  const brand = { ...b };
  for (const slot of ['logo', 'icon'] as const) {
    const img = draft.images?.[slot];
    if (img === undefined) continue;
    brand[slot] = {
      ...b[slot],
      value: img ? imageValue(img) : null,
      source: img ? 'org' : 'passbook',
    };
  }
  const colors = [v.background, v.foreground, v.label];
  brand.passColors = colors.every((c) => HEX.test(c))
    ? {
        ...b.passColors,
        value: { background: v.background, foreground: v.foreground, label: v.label },
        source: 'org',
      }
    : { ...b.passColors, value: null, source: 'passbook' };
  brand.name = { ...b.name, value: v.name };
  brand.logoHasName = { ...b.logoHasName, value: v.logoHasName };
  brand.accent =
    v.accent && HEX.test(v.accent)
      ? { value: v.accent, source: 'org' }
      : { value: null, source: 'passbook' };
  brand.mark = { ...b.mark, chosen: v.mark };
  brand.support = {
    email: v.supportEmail
      ? { value: v.supportEmail, source: 'org' }
      : { value: null, source: 'passbook' },
    url: v.supportUrl
      ? { value: v.supportUrl, source: 'org' }
      : { value: null, source: 'passbook' },
  };
  const channels = { ...rest.channels };
  for (const c of CHANNELS) {
    const want = draft.channels?.[c];
    if (!want) continue;
    const row = channels[c];
    const org = row.levels.find((l) => l.level === 'org');
    if (!org || (want === 'allowed') === row.allowed) continue;
    const levels = row.levels.map((l) => {
      if (l.level !== 'org') return l;
      const { reason: _reason, ...bare } = l;
      return want === 'blocked'
        ? { ...bare, state: levelState('org', 'blocked'), reason: 'blocked' as const }
        : { ...bare, state: levelState('org') };
    });
    const open = levels.filter((l) => l.level !== 'template').every((l) => l.state === 'ok');
    channels[c] = { ...row, allowed: want === 'allowed', levels, on: open };
  }
  return { ...rest, brand, channels };
}

export const draftChecks = (view: PassSetup, draft: Draft, now: number) =>
  orgSetupChecks(facts(view, draft), now);
