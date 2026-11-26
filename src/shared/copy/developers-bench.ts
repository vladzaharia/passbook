/** Words on the Workbench frame: the tool switcher, the context strip and the sandbox chip. Terse. */
export const BENCH_COPY = {
  /** The switcher's name; the tools' labels are DEV_COPY.workbench, the same in the tree, tab, h1 and title. */
  label: 'Workbench',
  skip: 'Skip to tool',
  /** Each tool's page description (meta and twin). */
  about: {
    console: 'Run any operation against your sandbox.',
    webhooks: 'Capture signed webhooks in your sandbox, verify them and replay them.',
    logs: 'Your sandbox’s API calls: metadata for 7 days, redacted bodies for 24 hours.',
    keys: 'Make, roll and revoke the keys of your sandbox.',
  },
  strip: {
    test: 'Test',
    live: 'Live',
    create: 'Create sandbox',
    closed: 'Sandbox closed',
    key: 'Key',
    runHere: 'Run here',
    runHereHint: 'Console runs use a short-lived token for this sandbox. No key is stored.',
  },
  chip: {
    name: 'Sandbox',
    menu: 'Sandbox menu',
    title: (slug: string) => `Your test sandbox: ${slug}. New emails go to the Test inbox.`,
    busy: (title: string) => `${title}, running`,
    items: {
      home: 'Workbench home',
      quickstart: 'Quickstart',
      startOver: 'Start over',
      delete: 'Delete sandbox',
    },
  },
  budget: 'Runs left this minute',
  pane: { close: 'Close' },
} as const;
