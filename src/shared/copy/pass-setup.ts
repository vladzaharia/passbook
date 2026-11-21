import { stoppingLevel } from '../channels.ts';
import type { ChainLevel, Channel, ChannelLevel } from '../contracts/channels.ts';
import type { PassSetupField, SetupCheckCode, SetupFixAction } from '../contracts/pass-setup.ts';
import { CHANNEL_LABEL } from './channels.ts';
import { scanLine } from './scan.ts';

/** Brand and channels: the page, its checks and its review. `{x}` marks a value. */
export const PASS_SETUP_COPY = {
  title: 'Brand and channels',
  areas: { brand: 'Brand', support: 'Support and email', channels: 'Channels' },
  toDo: '{n} to do',
  ready: 'Ready',
  levels: {
    passbook: 'PassBook',
    plan: 'Plan',
    org: 'Organization',
    template: 'Template',
    pass: 'This pass',
  } satisfies Record<ChainLevel, string>,
  /** The templates aggregate on the org page's chain. */
  templatesLevel: 'Templates {on}/{total}',
  status: {
    on: 'On',
    onSome: 'On for {on} of {total} templates',
    offTemplates: 'Off for every template',
    notReleased: 'Not available yet',
    notInPlan: 'Not in your plan',
    blocked: 'Blocked',
    accountNeeded: 'Account needed',
  },
  allowed: 'Allowed',
  /** Identity kinds as an org reads them; the platform console keeps "Platform". */
  identityKinds: { platform: 'Shared', managed: 'Managed', own: 'Own' },
  sources: {
    passbook: 'PassBook default',
    org: 'Organization',
    template: 'This template',
    templatesOwn: '{n} templates use their own',
    templateOwn: '1 template uses its own',
  },
  checks: {
    BRAND_LOGO: 'No logo. Passes show the placeholder.',
    BRAND_ICON: 'No icon. The lock screen shows the placeholder.',
    BRAND_COLORS: 'Templates use their own colours.',
    BRAND_CONTRAST: 'Pass text is hard to read on the background.',
    ACCENT_CONTRAST: 'The accent is too faint on {theme} pages, so holders see the default.',
    SUPPORT_MISSING: "Pass backs list PassBook's support.",
    APPLE_SHARED_ID: "Apple passes sign with PassBook's shared ID.",
    APPLE_ID_FAILED: 'Setting up your Apple ID failed.',
    APPLE_ID_EXPIRING: 'The Apple certificate expires in {days} days.',
    APPLE_PUSH: 'Apple pushes are failing. Passes do not update on devices.',
    WALLET_ACCOUNT: '{channel} needs an account.',
    NO_CHANNEL: 'No channel is on. Holders get nothing.',
    TEMPLATE_BRAND_OWN: '{n} templates use their own brand.',
  } satisfies Record<SetupCheckCode, string>,
  /** Other wordings of a check: one template, one day, already expired. */
  checkVariants: {
    templateBrandOwnOne: '1 template uses its own brand.',
    appleExpiresOne: 'The Apple certificate expires in 1 day.',
    appleExpired: 'The Apple certificate has expired. Passes stop updating.',
  },
  fixes: {
    upload_logo: 'Add logo',
    upload_icon: 'Add icon',
    use_logo_colors: 'Use logo colours',
    edit_colors: 'Choose colours',
    fix_contrast: 'Fix contrast',
    fix_accent: 'Fix accent',
    edit_support: 'Add support',
    start_apple_managed: 'Get your own ID',
    retry_identity_run: 'Retry',
    renew_identity: 'Renew now',
    replace_certificate: 'Replace certificate',
    check_push: 'Check push',
    setup_wallet_account: 'Set up',
    allow_channel: 'Allow {channel}',
    review_template: 'Review',
  } satisfies Record<SetupFixAction, string>,
  fields: {
    'brand.name': 'Name on passes',
    'brand.logo': 'Logo',
    'brand.icon': 'Icon',
    'brand.webLogo': 'Web logo',
    'brand.webLogoSameAsLogo': 'Web logo',
    'brand.passColors': 'Pass colours',
    'brand.logoHasName': 'Logo includes the name',
    'brand.accent': 'Accent',
    'brand.mark': 'PassBook mark',
    'brand.support.email': 'Support email',
    'brand.support.url': 'Support link',
    'brand.email.fromName': 'Email sender',
    'brand.email.buddy': 'Buddy in emails',
    'channels.mobile': CHANNEL_LABEL.mobile,
    'channels.apple': CHANNEL_LABEL.apple,
    'channels.google': CHANNEL_LABEL.google,
    'channels.samsung': CHANNEL_LABEL.samsung,
    'channels.paper': CHANNEL_LABEL.paper,
    'channels.nfc': CHANNEL_LABEL.nfc,
  } satisfies Record<PassSetupField, string>,
  sameAsLogo: 'Same as logo',
  impact: {
    passes: '{n} passes update on devices.',
    passesOne: '1 pass updates on devices.',
    stops: '{channel} stops for {templates} templates · {passes} passes.',
    copiesKeep: 'Copies keep working.',
  },
  review: {
    title: 'Save {n} changes',
    titleOne: 'Save 1 change',
    save: 'Save',
    blockAndSave: 'Block and save',
  },
  stale: 'Someone else changed these settings. Review them and save again.',
};

/**
 * A channel row's status line: the stopping level's words, else how many templates have it on.
 * The org page, the platform org page and the template page read the same line.
 */
export function channelStatusLine(row: {
  levels: readonly ChannelLevel[];
  templates: { on: number; total: number };
}): string {
  const s = PASS_SETUP_COPY.status;
  const stop = stoppingLevel(row.levels);
  if (stop?.level === 'plan') return s.notInPlan;
  if (stop?.level === 'passbook') return s.notReleased;
  if (stop?.state === 'needs') return s.accountNeeded;
  if (stop?.level === 'org') return s.blocked;
  const { on, total } = row.templates;
  if (on === total) return s.on;
  return on === 0 ? s.offTemplates : scanLine(s.onSome, { on, total });
}

/** A fix's button label: "Allow Apple Wallet" names its channel. */
export const fixLabel = (action: SetupFixAction, target?: string): string =>
  scanLine(PASS_SETUP_COPY.fixes[action], { channel: CHANNEL_LABEL[target as Channel] ?? '' });
