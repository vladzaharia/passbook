import { BUDDY_LINES } from './developers-buddy.ts';

/** The signed-out gate and the state cards' words. One line says what you get; one button signs in. */
export const GATE_COPY = {
  signIn: 'Sign in',
  docs: 'Read the docs',
  lines: {
    console: BUDDY_LINES.gateConsole,
    keys: BUDDY_LINES.gateKeys,
    logs: BUDDY_LINES.gateLogs,
    webhooks: BUDDY_LINES.gateWebhooks,
  },
  notFound: { home: 'Developers home', search: 'Search' },
  search: {
    try: 'Try',
  },
} as const;
