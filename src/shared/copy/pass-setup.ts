import { stoppingLevel } from '../channels.ts';
import type { ChainLevel, Channel, ChannelLevel } from '../contracts/channels.ts';
import type { PassSetupField, SetupCheckCode, SetupFixAction } from '../contracts/pass-setup.ts';
import { CHANNEL_LABEL } from './channels.ts';
import { scanLine } from './scan.ts';
import { WALLET_SETUP_LABEL } from './wallet-setup.ts';

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
    setup_wallet_account: WALLET_SETUP_LABEL,
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
    'brand.mark': 'PassBook footer',
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
    stops: '{channel} stops for {templates} · {passes}.',
    copiesKeep: 'Copies keep working.',
  },
  review: {
    title: 'Save {n} changes',
    titleOne: 'Save 1 change',
    save: 'Save',
    blockAndSave: 'Block and save',
  },
  stale: 'Someone else changed these settings. Review them and save again.',
  page: {
    passes: '{n} passes',
    passesOne: '1 pass',
    noPasses: 'No passes yet',
    allSet: 'All set',
    saved: 'Saved',
    changes: '{n} changes',
    changesOne: '1 change',
    review: 'Review',
    back: 'Back',
    discard: 'Discard',
    cards: { brand: 'Brand', support: 'Support and email', channels: 'Channels' },
    mode: { live: 'Live', test: 'Test' },
    previewHolder: 'Preview as holder',
    copyRequest: 'Copy as API request',
    auditLog: 'Audit log',
    edit: 'Edit',
    templates: 'Templates',
    noTemplates: 'No templates yet',
    previewTabs: 'Preview',
    previewEmail: 'Email',
    previewPage: 'Page',
    previewPaper: 'Paper follows each template.',
    lockedBy: '{level} stops it',
    unchanged: 'No changes',
    loading: 'Loading brand and channels',
    readOnly: 'You can view this page. Changing it needs org manage access.',
  },
  brand: {
    name: 'Name on passes',
    logo: 'Logo',
    icon: 'Icon',
    webLogo: 'Web logo',
    logoHelp: 'PNG · up to 480 × 150',
    iconHelp: 'PNG · 114 × 114',
    webLogoHelp: 'PNG · up to 1024 × 512',
    chooseLogo: 'Choose logo',
    chooseIcon: 'Choose icon',
    chooseWebLogo: 'Choose web logo',
    useAnother: 'Use another',
    remove: 'Remove',
    staged: 'Added. Saves with the rest.',
    colours: 'Pass colours',
    background: 'Background',
    text: 'Text',
    labels: 'Labels',
    fromLogo: 'From logo',
    notSet: 'From template',
    contrast: 'Text {text} · Labels {labels}',
    colourError: 'Use a 6-digit hex like #0f766e.',
    colourSet: 'Set all three colours.',
    accent: 'Accent',
    accentHelp: 'Pages and emails',
    mark: 'PassBook footer',
    markOptions: {
      full: 'Issued with PassBook',
      small: 'Powered by PassBook',
      none: 'No PassBook footer',
    },
  },
  support: {
    email: 'Support email',
    url: 'Support link',
    fromName: 'Email sender',
    buddy: 'Buddy in emails',
    emailPlaceholder: 'support@passbook.mobile',
    fromPlaceholder: '{name} via PassBook',
  },
  palettes: { dark: 'Dark', bold: 'Bold', light: 'Light' },
  channelsCard: {
    signedAs: 'Signed as',
    history: 'History',
    account: 'Account',
    push: { healthy: 'Push working', failing: 'Push failing', unknown: 'Push unchecked' },
    renews: 'Renews {date}',
    olderPasses: "{n} older passes on PassBook's ID",
    runSteps: ['Reserve the ID', 'Create the pass type', 'Issue the certificate', 'Check push'],
    runFailed: 'Failed. Retry from the check.',
  },
  account: {
    managed: 'Managed by PassBook',
    managedHint: 'PassBook creates and runs the issuer.',
    shared: 'Share your issuer',
    sharedHint: "Add PassBook's service account to your issuer.",
    create: 'Create the issuer',
    connect: 'Connect',
    issuerId: 'Issuer ID',
    issuerError: 'Digits only.',
    addAs: 'Add this address as a user of your issuer in the Google Pay & Wallet Console.',
    steps: ['Create the issuer', 'Account check', 'Test round trip'],
    waiting: 'PassBook is finishing the setup.',
    failed: 'Setup failed.',
    retry: 'Retry',
    liveOnly: 'Live mode only.',
    connected: 'Connected.',
  },
  sourceTags: {
    placeholder: 'Placeholder',
    fromLogo: 'From logo',
    eachTemplate: 'Each template',
    plan: 'Plan',
    default: 'Default',
    passbook: 'PassBook',
  },
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
