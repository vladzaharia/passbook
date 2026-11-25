/** Words on the developer portal. Terse: labels, not paragraphs. */
export const DEV_COPY = {
  brand: 'Developers',
  nav: [
    { key: 'quickstart', label: 'Quickstart' },
    { key: 'guides', label: 'Guides' },
    { key: 'reference', label: 'Reference' },
    { key: 'webhooks', label: 'Webhooks' },
    { key: 'logs', label: 'Logs' },
  ],
  signIn: 'Sign in',
  skip: 'Skip to content',
  menu: 'Menu',
  sheet: {
    sandbox: 'Sandbox',
    workbench: 'Workbench',
    keys: 'Keys',
    spaces: 'Spaces',
    signIn: 'Sign in',
  },
  home: {
    eyebrow: 'REST · TypeScript · Python · Go · Webhooks',
    title: 'Wallet passes from your code,',
    titleFoil: 'live as you type.',
    lede: 'Create Apple, Google and Samsung passes, change them, hear back through webhooks. Your sandbox renders every pass as a test preview; nothing is issued.',
    start: 'Start the quickstart',
    reference: 'API reference',
    install: 'npm i @passbook/sdk',
    tiles: [
      {
        key: 'quickstart',
        title: 'Quickstart',
        line: 'Sandbox, first request, your pass live.',
        foot: '5 min',
      },
      {
        key: 'playground',
        title: 'Playground',
        line: 'Edit fields, watch every wallet change.',
        foot: '',
      },
      {
        key: 'reference',
        title: 'API reference',
        line: 'Every operation, runnable in place.',
        foot: '',
      },
    ],
    sandbox: 'Your sandbox',
    guides: 'Guides',
    changelog: 'Changelog',
  },
  reference: {
    title: 'API reference',
    lede: 'One page per operation, grouped by resource. The last segment is the SDK method name, such as /passes/create.',
    consoleOnly: 'Console only',
    consoleOnlyLine: 'Signed-in console sessions only. An API key cannot call these.',
    returns: 'Returns',
    errors: 'Errors',
    errorsLine: 'Each operation lists the codes it can return. Branch on code, not on the message.',
    allCodes: (n: number) => `All ${n} codes`,
    body: 'Body',
    onThisPage: 'On this page',
    copy: 'Copy',
    copyAs: 'Copy as',
    examples: 'Examples',
    sdk: 'SDK',
    sdkSoon: 'SDK coming soon',
    tryIt: 'Try it',
    signInToTry: 'Sign in to try',
    tryPlaceholder: 'The console opens here once you are signed in.',
  },
  console: {
    title: 'Console',
    line: 'A new key or secret in a response shows in full.',
    signIn: 'Sign in to try',
    placeholder: 'Pick an operation after you sign in.',
  },
  footer: {
    changelog: 'Changelog',
    whatsNew: "What's new",
    openapi: 'OpenAPI',
    llms: 'llms.txt',
    status: 'Status',
  },
  slots: {
    playground: {
      title: 'Playground',
      line: 'Edit a pass and watch Apple, Google, Samsung and paper change.',
    },
    guides: {
      title: 'Guides',
      line: 'Each recipe runs in your sandbox and ends at a test preview.',
    },
  },
  notFound: {
    title: 'Page not found',
    line: 'Nothing lives at this address.',
    home: 'Home',
  },
  guides: {
    title: 'Guides',
    openConsole: 'Open in console',
    consoleHint: 'Opens the console with this request filled in.',
    copyForAi: 'Copy for AI',
    markdown: 'Markdown',
    operations: 'Operations',
  },
} as const;

/** The steps of the integration journey, in order. A guide sits in one; its tile takes the step's tone. */
export const DEV_GUIDE_STEPS = [
  { id: 'start', label: 'Start', tone: 'teal' },
  { id: 'issue', label: 'Issue', tone: 'blue' },
  { id: 'change', label: 'Change', tone: 'violet' },
  { id: 'door', label: 'At the door', tone: 'amber' },
  { id: 'connect', label: 'Connect', tone: 'slate' },
  { id: 'launch', label: 'Launch', tone: 'green' },
] as const;

export type DevGuideStep = (typeof DEV_GUIDE_STEPS)[number]['id'];

/** The guides the portal carries, in reading order within each step (design-portal-devex.md §5). */
export const DEV_GUIDES = [
  {
    id: 'org-setup',
    title: 'Set up an organization in one call',
    line: 'Brand, support, channels',
    step: 'start',
  },
  {
    id: 'release-a-template',
    title: 'Release a template',
    line: 'Try, review, release',
    step: 'start',
  },
  { id: 'test-mode', title: 'Test mode', line: 'Inbox, preview, limits', step: 'start' },
  {
    id: 'issue-on-purchase',
    title: 'Issue on purchase',
    line: 'Checkout webhook to pass',
    step: 'issue',
  },
  { id: 'bulk-import', title: 'Bulk import', line: 'A CSV to passes', step: 'issue' },
  {
    id: 'import-auto-map',
    title: 'Import with auto mapping',
    line: 'Map a CSV from the template',
    step: 'issue',
  },
  { id: 'update-a-pass', title: 'Update a pass', line: 'Change fields, notify', step: 'change' },
  {
    id: 'change-many-passes',
    title: 'Change many passes',
    line: 'Preview, run, undo',
    step: 'change',
  },
  { id: 'pass-lifecycle', title: 'Pass lifecycle', line: 'Void, remove, delete', step: 'change' },
  {
    id: 'scan-setup',
    title: 'Set up scanning in one call',
    line: 'Doors, staff, devices',
    step: 'door',
  },
  {
    id: 'check-in-at-the-door',
    title: 'Check in at the door',
    line: 'Scan and admit',
    step: 'door',
  },
  { id: 'nfc', title: 'NFC', line: 'Tags and bindings', step: 'door' },
  { id: 'react-to-events', title: 'React to events', line: 'Webhooks or polling', step: 'connect' },
  { id: 'partner-apps', title: 'Partner apps', line: 'Installations', step: 'connect' },
  { id: 'go-live', title: 'Go live', line: 'The checklist', step: 'launch' },
] as const satisfies readonly { id: string; title: string; line: string; step: DevGuideStep }[];
