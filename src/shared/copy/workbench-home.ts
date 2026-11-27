/** Home's words (design §1.7, §3.1, §6). Shared states live in workbench-states.ts. */
export const WB_HOME_COPY = {
  menu: { more: 'More', newKey: 'New key', reset: 'Reset sandbox', admin: 'Open in admin' },
  next: {
    label: 'Next step',
    progress: (done: number, total: number) => `${done} of ${total} done`,
    steps: [
      { title: 'Make your first call', action: 'Open Quickstart', tool: 'quickstart' },
      { title: 'Change the pass', action: 'Open Quickstart', tool: 'quickstart' },
      { title: 'Hear a webhook', action: 'Open Events', tool: 'events' },
    ],
    console: 'Run in Console',
  },
  phone: {
    title: 'On my phone',
    qrAlt: 'QR code of the Test preview link',
    open: 'Open preview',
    empty: 'Make a pass to preview it here',
    emptyAction: 'Make one in Design',
  },
  stats: {
    passes: 'Passes',
    templates: 'Templates',
    endpoints: 'Endpoints',
    keys: 'Keys',
    errors: 'Errors',
    failed: 'Failed deliveries',
    inbox: 'Test emails',
    expiring: 'Keys expiring',
    of: (limit: number) => `of ${limit}`,
  },
  calls: { title: 'Recent calls', all: 'All logs', empty: 'Waiting for your first call' },
  events: {
    title: 'Recent events',
    all: 'All events',
    empty: 'Listening for events',
    add: 'Add endpoint',
  },
  passes: { title: 'Test passes', all: 'All passes', empty: 'No passes', action: 'Make one' },
  live: { calls: 'Calls update live', events: 'Events update live' },
  celebrate: {
    firstCall: 'First successful call',
    onPhone: 'First pass saved on a phone',
    quickstart: 'Quickstart done',
    webhook: 'First webhook delivered',
    view: 'View',
  },
} as const;
