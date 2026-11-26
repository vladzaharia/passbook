import type { SetupCheckCode } from '../contracts/pass-setup.ts';

/** Words for fixing a check where it shows (new pass, pass page, overview) and for the platform's org Features. */
export const PASS_FIX_COPY = {
  sheet: {
    title: { logo: 'Add logo', icon: 'Add icon' },
    save: 'Save',
    cancel: 'Cancel',
    saved: { logo: 'Logo added for every pass.', icon: 'Icon added for every pass.' },
    stale: 'Someone else changed the brand. Try again.',
    colorsTitle: 'Pass colours',
    accentTitle: 'Accent',
    colorsSaved: 'Pass colours saved for every pass.',
    accentSaved: 'Accent saved.',
  },
  setUp: 'Set up',
  overview: {
    step: 'Brand and channels',
    toDo: '{n} to do',
    open: 'Open',
    /** The short name of each to-do in the overview step's line. */
    names: {
      BRAND_LOGO: 'Logo',
      BRAND_ICON: 'Icon',
      BRAND_COLORS: 'Colors',
      BRAND_CONTRAST: 'Contrast',
      ACCENT_CONTRAST: 'Accent',
      SUPPORT_MISSING: 'Support',
      APPLE_SHARED_ID: 'Apple ID',
      APPLE_ID_FAILED: 'Apple ID',
      APPLE_ID_EXPIRING: 'Apple ID',
      APPLE_PUSH: 'Push',
      WALLET_ACCOUNT: 'Wallet account',
      NO_CHANNEL: 'Channels',
      TEMPLATE_BRAND_OWN: 'Templates',
    } satisfies Record<SetupCheckCode, string>,
  },
  platform: {
    channels: 'Channels',
    include: 'Include',
    hold: 'Hold',
    release: 'Release',
    held: 'Held',
    appleId: 'Apple ID',
    certificates: 'Certificates',
    sharedNote: "Signs with PassBook's shared ID.",
    includeHelp: 'Opens the plan override for this feature.',
  },
};
