import { THEME_COLOR } from '../generated/resolved-tokens.ts';
import { stoppingLevel } from './channels.ts';
import { CHANNELS, type Channel } from './contracts/channels.ts';
import type { PassSetup, SetupCheck, SetupCheckCode } from './contracts/pass-setup.ts';
import { CHANNEL_LABEL } from './copy/channels.ts';
import { PASS_SETUP_COPY } from './copy/pass-setup.ts';
import { scanLine } from './copy/scan.ts';
import { contrast, parseColor } from './pass-view/color.ts';

/** Everything the checks read: the view without its checks. The loader and the page's draft both build one. */
export type SetupFacts = Omit<PassSetup, 'checks'>;

const DAY = 86_400_000;
/** Apple's minimums for pass text and labels on the background, and an accent's on a page. */
const TEXT_MIN = 4.5;
const LABEL_MIN = 3;
const ACCENT_MIN = 3;
/** The renewal ladder of a managed ID: a warning from 30 days, an error from 14. */
const EXPIRY_WARN_DAYS = 30;
const EXPIRY_ERROR_DAYS = 14;

const ratio = (a: string, b: string): number => {
  const x = parseColor(a);
  const y = parseColor(b);
  return x && y ? contrast(x, y) : 21;
};

type Variant = keyof typeof PASS_SETUP_COPY.checkVariants;
type Row = Omit<SetupCheck, 'message'> & {
  params?: Record<string, string | number>;
  /** A wording other than the code's own: one template, one day, expired. */
  variant?: Variant;
};

function toCheck({ params, variant, ...row }: Row): SetupCheck {
  const text = variant ? PASS_SETUP_COPY.checkVariants[variant] : PASS_SETUP_COPY.checks[row.code];
  return { ...row, message: scanLine(text, params) };
}

/** Templates that follow the org's image in `slot` and own only PassBook's placeholder there. */
const placeholderTemplates = (f: SetupFacts, slot: 'logo' | 'icon') =>
  f.templates.filter((t) => t.placeholders.includes(slot) && !t.ownBrand.includes(slot));

function brandRows(f: SetupFacts): Row[] {
  const out: Row[] = [];
  const b = f.brand;
  // No templates yet: the first comes from a blueprint, whose images are placeholders.
  for (const slot of ['logo', 'icon'] as const) {
    const using = placeholderTemplates(f, slot);
    if (b[slot].value || (f.templates.length > 0 && using.length === 0)) continue;
    out.push({
      code: slot === 'logo' ? 'BRAND_LOGO' : 'BRAND_ICON',
      level: 'warn',
      area: 'brand',
      ...(using.length ? { templateIds: using.map((t) => t.id) } : {}),
      fix: { action: slot === 'logo' ? 'upload_logo' : 'upload_icon' },
    });
  }
  const colors = b.passColors.value;
  if (!colors)
    out.push({
      code: 'BRAND_COLORS',
      level: 'info',
      area: 'brand',
      fix: { action: b.logo.value ? 'use_logo_colors' : 'edit_colors' },
    });
  else if (
    ratio(colors.foreground, colors.background) < TEXT_MIN ||
    ratio(colors.label, colors.background) < LABEL_MIN
  )
    out.push({
      code: 'BRAND_CONTRAST',
      level: 'warn',
      area: 'brand',
      fix: { action: 'fix_contrast' },
    });
  const accent = b.accent.source === 'org' ? b.accent.value : null;
  if (accent) {
    const faint = (['light', 'dark'] as const).find(
      (t) => ratio(accent, THEME_COLOR[t]) < ACCENT_MIN,
    );
    if (faint)
      out.push({
        code: 'ACCENT_CONTRAST',
        level: 'warn',
        area: 'brand',
        params: { theme: faint },
        fix: { action: 'fix_accent' },
      });
  }
  const own = f.templates.filter((t) => t.ownBrand.length > 0);
  if (own.length)
    out.push({
      code: 'TEMPLATE_BRAND_OWN',
      level: 'info',
      area: 'brand',
      params: { n: own.length },
      ...(own.length === 1 ? { variant: 'templateBrandOwnOne' as const } : {}),
      templateIds: own.map((t) => t.id),
      fix: { action: 'review_template', ...(own.length === 1 ? { target: own[0]?.id } : {}) },
    });
  if (!b.support.email.value && !b.support.url.value)
    out.push({
      code: 'SUPPORT_MISSING',
      level: 'warn',
      area: 'support',
      fix: { action: 'edit_support' },
    });
  return out;
}

const RUN_ACTIVE = new Set(['queued', 'running', 'waiting']);

function appleRows(f: SetupFacts, now: number): Row[] {
  const out: Row[] = [];
  const { identity, run } = f.apple;
  const at = { area: 'channels', channel: 'apple' } as const;
  if (run?.state === 'failed' && run.kind !== 'revoke')
    out.push({
      code: 'APPLE_ID_FAILED',
      level: 'error',
      ...at,
      fix: { action: 'retry_identity_run', target: run.id },
    });
  else if (!identity && f.apple.managedAllowed && !(run && RUN_ACTIVE.has(run.state)))
    out.push({
      code: 'APPLE_SHARED_ID',
      level: 'info',
      ...at,
      fix: { action: 'start_apple_managed' },
    });
  if (identity?.notAfter != null) {
    const days = Math.max(0, Math.ceil((identity.notAfter - now) / DAY));
    if (days <= EXPIRY_WARN_DAYS)
      out.push({
        code: 'APPLE_ID_EXPIRING',
        level: days <= EXPIRY_ERROR_DAYS ? 'error' : 'warn',
        ...at,
        params: { days },
        ...(days <= 1
          ? { variant: days === 0 ? ('appleExpired' as const) : ('appleExpiresOne' as const) }
          : {}),
        fix: {
          action: identity.kind === 'managed' ? 'renew_identity' : 'replace_certificate',
          target: identity.id,
        },
      });
  }
  if (f.apple.push === 'failing')
    out.push({
      code: 'APPLE_PUSH',
      level: 'warn',
      ...at,
      fix: { action: 'check_push', ...(identity ? { target: identity.id } : {}) },
    });
  return out;
}

function channelRows(f: SetupFacts): Row[] {
  const out: Row[] = [];
  for (const c of ['google', 'samsung'] as const) {
    const stop = stoppingLevel(f.channels[c].levels);
    if (stop?.level === 'org' && stop.state === 'needs')
      out.push({
        code: 'WALLET_ACCOUNT',
        level: 'warn',
        area: 'channels',
        channel: c,
        params: { channel: CHANNEL_LABEL[c] },
        fix: { action: 'setup_wallet_account', target: c },
      });
  }
  if (CHANNELS.every((c) => !f.channels[c].on)) {
    // Apple first, as the page offers; only a channel the org itself stops can be allowed.
    const order: Channel[] = ['apple', 'mobile', ...CHANNELS];
    const target =
      order.find((c) => stoppingLevel(f.channels[c].levels)?.level === 'org') ?? 'apple';
    out.push({
      code: 'NO_CHANNEL',
      level: 'error',
      area: 'channels',
      fix: { action: 'allow_channel', target },
    });
  }
  return out;
}

const RANK = { error: 0, warn: 1, info: 2 } as const;

/**
 * Every check for an org, errors first, then warnings, then suggestions; the same on the server
 * and in the page. `now` dates the certificate expiry.
 */
export function orgSetupChecks(f: SetupFacts, now: number): SetupCheck[] {
  return [...brandRows(f), ...appleRows(f, now), ...channelRows(f)]
    .map(toCheck)
    .sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** The to-do count: warnings and errors. Suggestions (info) never count. */
export const todoCount = (checks: readonly Pick<SetupCheck, 'level'>[]): number =>
  checks.filter((c) => c.level !== 'info').length;

/** The checks a pass of `templateId` shows: those naming it, and those about every template. */
export const checksForTemplate = (
  checks: readonly SetupCheck[],
  templateId: string,
): SetupCheck[] => checks.filter((c) => !c.templateIds || c.templateIds.includes(templateId));

/** The template lint PLATFORM_BRANDING names a slot (`path`); this is its check. */
export const PLATFORM_BRANDING_CHECK: Record<'logo' | 'icon', SetupCheckCode> = {
  logo: 'BRAND_LOGO',
  icon: 'BRAND_ICON',
};
