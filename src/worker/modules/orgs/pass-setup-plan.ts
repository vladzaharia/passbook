import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import type {
  PassSetup,
  PassSetupField,
  PassSetupPatch,
} from '../../../shared/contracts/pass-setup.ts';
import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import type { OrgSettings } from '../settings/service.ts';
import { passLook } from './branding-stale.ts';
import type { StoredBranding } from './pass-setup-load.ts';
import type { StagedImages } from './pass-setup-stage.ts';

type Branding = StoredBranding;
type Brand = NonNullable<PassSetupPatch['brand']>;

/** What a save changes, before anything is written. */
export interface SetupPlan {
  name: string | null;
  /** The new `orgs.branding`, or null when it does not change. */
  branding: Branding | null;
  /** Setting keys to write (value) and reset to their default (null), as `checkValues` takes them. */
  values: Record<string, unknown>;
  /** Channels whose enrolment the save turns on (already known to be ready). */
  enable: WalletProvider[];
  /** Channels the save blocks, and those it allows, as they were not before. */
  blocked: Channel[];
  allowed: Channel[];
  diff: { field: PassSetupField; before: Json; after: Json }[];
  /** The save changes how a built pass looks. */
  passLook: boolean;
  /** Fields only an `org:write` caller may change; false for a brand-kit-only save. */
  beyondBrandKit: boolean;
}

/** An image as the view and the diff show it. */
const shown = (image: { sha: string; w: number; h: number } | null | undefined) =>
  image ? { sha: image.sha, w: image.w, h: image.h } : null;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Fields of the brand block that live in `orgs.branding`: a `brand:manage` key may change these. */
const KIT_FIELDS = [
  'logo',
  'icon',
  'webLogo',
  'passColors',
  'logoHasName',
  'accent',
  'mark',
] as const;

export function touchesBeyondBrandKit(patch: PassSetupPatch): boolean {
  const brand = patch.brand ?? {};
  const kit = new Set<string>([...KIT_FIELDS, 'webLogoSameAsLogo']);
  return (
    Object.keys(patch.channels ?? {}).length > 0 ||
    Object.keys(brand).some((k) => !kit.has(k)) ||
    // The sameAsLogo flag is a setting, written under org:write.
    brand.webLogoSameAsLogo !== undefined
  );
}

/** The patch against the current view, stored branding and settings. Pure. */
export function planOf(
  patch: PassSetupPatch,
  view: PassSetup,
  stored: Branding,
  settings: OrgSettings,
  staged: StagedImages,
  ready: ReadonlySet<WalletProvider>,
): SetupPlan {
  const brand: Brand = patch.brand ?? {};
  const diff: SetupPlan['diff'] = [];
  const change = (field: PassSetupField, before: unknown, after: unknown): boolean => {
    if (same(before, after)) return false;
    diff.push({ field, before: (before ?? null) as Json, after: (after ?? null) as Json });
    return true;
  };
  const values: Record<string, unknown> = {};
  const next: Branding = { ...stored };
  let branding = false;
  const set = <K extends keyof Branding>(key: K, value: Branding[K] | undefined) => {
    branding = true;
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  const b = view.brand;

  const name = brand.name !== undefined && change('brand.name', b.name.value, brand.name);
  for (const slot of ['logo', 'icon'] as const) {
    const image = staged[slot];
    if (image !== undefined && change(`brand.${slot}`, b[slot].value, shown(image)))
      set(slot, image ?? undefined);
  }
  const web = staged.webLogo;
  if (web !== undefined && change('brand.webLogo', b.webLogo.value, shown(web)))
    set('web', web ?? undefined);
  if (
    brand.passColors !== undefined &&
    change('brand.passColors', b.passColors.value, brand.passColors)
  )
    set('passColors', brand.passColors ?? undefined);
  if (
    brand.logoHasName !== undefined &&
    change('brand.logoHasName', b.logoHasName.value, brand.logoHasName)
  )
    set('logoHasName', brand.logoHasName);
  if (brand.accent !== undefined && change('brand.accent', b.accent.value, brand.accent))
    set('accent', brand.accent ?? undefined);
  if (brand.mark !== undefined && change('brand.mark', b.mark.chosen, brand.mark))
    set('mark', brand.mark);

  const setting = (field: PassSetupField, key: string, before: unknown, after: unknown) => {
    if (after !== undefined && change(field, before, after)) values[key] = after;
  };
  setting(
    'brand.webLogoSameAsLogo',
    'branding.webLogoSameAsLogo',
    b.webLogo.sameAsLogo,
    brand.webLogoSameAsLogo,
  );
  const support = brand.support ?? {};
  setting('brand.support.email', 'support.email', b.support.email.value, support.email);
  setting('brand.support.url', 'support.url', b.support.url.value, support.url);
  // A cleared address must not fall back to the one an older save kept in the branding.
  if (support.email === null && stored.supportEmail !== undefined) set('supportEmail', undefined);
  if (support.url === null && stored.supportUrl !== undefined) set('supportUrl', undefined);
  const email = brand.email ?? {};
  // The view shows the default sender text when no name is set; clearing compares with the stored value.
  setting(
    'brand.email.fromName',
    'email.fromName',
    settings['email.fromName'] ?? null,
    email.fromName,
  );
  setting('brand.email.buddy', 'email.buddy', b.email.buddy, email.buddy);

  const blocked: Channel[] = [];
  const allowed: Channel[] = [];
  const list = new Set<Channel>(settings['channels.blocked']);
  let nfc = settings['nfc.tags'];
  for (const c of CHANNELS) {
    const want = patch.channels?.[c];
    if (want === undefined) continue;
    const now = view.channels[c].allowed ? 'allowed' : 'blocked';
    if (!change(`channels.${c}`, now, want)) continue;
    if (want === 'blocked') {
      blocked.push(c);
      list.add(c);
    } else {
      allowed.push(c);
      list.delete(c);
    }
    if (c === 'nfc') nfc = { ...nfc, enabled: want === 'allowed' };
  }
  if (blocked.length || allowed.length) {
    values['channels.blocked'] = [...list];
    if (!same(nfc, settings['nfc.tags'])) values['nfc.tags'] = nfc;
  }
  const enable = [...ready];
  const nextBranding = branding ? next : null;
  const before = { name: b.name.value ?? '', branding: JSON.stringify(stored) };
  const after = {
    name: name ? (brand.name as string) : before.name,
    branding: JSON.stringify(nextBranding ?? stored),
  };
  return {
    name: name ? (brand.name as string) : null,
    branding: nextBranding,
    values,
    enable,
    blocked,
    allowed,
    diff,
    passLook: passLook(before) !== passLook(after),
    beyondBrandKit: touchesBeyondBrandKit(patch),
  };
}
