import type { JoinReadinessIssue } from '../contracts/join.ts';

/** Words for join links: the admin card, the print sign and the public page. `{name}` marks a value. */
export const JOIN_COPY = {
  card: {
    title: 'Join link',
    open: 'Open to everyone',
    askFor: 'Ask visitors for',
    name: 'Name',
    fills: 'Saved in {label}',
    email: 'Email',
    dailyLimit: 'Daily limit',
    today: '{n} today',
    limitReached: 'Limit reached',
    copy: 'Copy link',
    print: 'Print sign',
    rotate: 'Make a new link',
    askAdmin: 'Ask an org admin.',
    needsCode: 'Needs a generated barcode.',
  },
  rotateConfirm: {
    title: 'Make a new link?',
    body: 'The old link and QR stop working.',
    confirm: 'Make new link',
  },
  toast: {
    copied: 'Link copied',
    on: 'Join link on',
    off: 'Join link off',
    rotated: 'New link made',
  },
  readiness: {
    no_release: 'Release this template in {mode} to turn on the join link.',
    barcode_input: 'The barcode shows {label}. Use a generated code in the designer.',
    input_needed: '{label} has no default. Give it one in the designer.',
    archived: 'This template is archived.',
  },
  sign: {
    title: 'Get your card',
    scan: 'Scan with your camera.',
    lineLabel: 'Extra line',
    linePlaceholder: 'Free. One card each.',
    print: 'Print',
    crumb: 'Print sign',
    none: 'No join link yet.',
    back: 'Turn on join link',
  },
  page: {
    title: 'Get your {org} card',
    firstName: 'First name',
    email: 'Email',
    submit: 'Get my card',
    inApp: 'Open in Safari to add to Apple Wallet.',
    copyLink: 'Copy link',
    testStrip: 'Test card. It is not real and will be deleted.',
    checkEmail: {
      title: 'Check your email',
      body: 'We sent your {org} card to {email}.',
      hint: 'Not there? Check spam. It can take a few minutes.',
      another: 'Use a different email',
    },
  },
  refusal: {
    turnstile: 'Verification failed. Try again.',
    deviceLimit: 'This phone already got a card today. Ask staff.',
    tooManyTries: 'Too many tries. Wait a minute and try again.',
    dailyLimit: 'No more cards today. Ask staff.',
    closed: 'Not taking new cards right now. Ask staff.',
    /** Unknown, rotated and expired links look alike on purpose; the first sentence is the heading. */
    expired: 'This link does not work.',
  },
  /** The pass email of a joined card says "card", as the page and the sign do. */
  mailTitle: 'Your card is ready',
  mailSubject: '{org} card',
  mailLine: "You asked for this card at {org}. Didn't? Ignore this email.",
  errors: {
    JOIN_LINK_CHANGED: 'This link changed. Reload and try again.',
  },
} as const;

/** The admin line for one readiness issue. `label` names the input, `mode` is Live or Test. */
export function joinIssueLine(
  issue: JoinReadinessIssue,
  names: { label?: string; mode?: 'Live' | 'Test' } = {},
): string {
  return JOIN_COPY.readiness[issue.code]
    .replace('{label}', names.label ?? issue.label ?? issue.input ?? '')
    .replace('{mode}', names.mode ?? 'Live');
}
