import type { WbTool } from '../workbench.ts';
import { WB_AREA_WORDS } from './workbench-areas.ts';

/**
 * The Workbench's own words: area names, groups, the bar, the switcher, attention and keys
 * (design §1.4, §1.6, §5.4). States live in workbench-states.ts.
 */
export const WB_AREA = WB_AREA_WORDS;

/** The nav label: the title, bar the Test inbox, which reads "Inbox" there. */
export const wbLabel = (t: WbTool): string => (t === 'inbox' ? 'Inbox' : WB_AREA[t].title);

/** The tab title when it says more than the h1: Events is where webhooks live. */
export const WB_TAB_TITLE: Partial<Record<WbTool, string>> = { events: 'Events and webhooks' };

export const WB_GROUPS = { make: 'Make', watch: 'Watch', setUp: 'Set up' } as const;

export const WB_SHELL_COPY = {
  mark: 'Workbench',
  nav: 'Workbench',
  skipNav: 'Skip to navigation',
  skipTool: 'Skip to tool',
  search: 'Search tools, ids, docs',
  searchShort: 'Search',
  docs: 'Docs',
  test: 'Test',
  sandbox: 'Sandbox',
  organization: 'Organization',
  switchContext: 'Switch context',
  findContext: 'Find a context',
  switchGroup: 'Switch',
  goGroup: 'Go',
  goLive: 'Go live',
  openInAdmin: 'Open in admin',
  jump: 'Jump',
  shortcuts: 'Keyboard shortcuts',
  singleKeys: 'Single-key shortcuts',
  singleKeysHelp: 'Letters, g chords and ?. ⌘K, ⌘↵, ⌘S, ⌘/ and Esc always work.',
  markSeen: 'Mark seen',
  testDataOnly: 'Test data only',
  chordHint: 'Go to…',
} as const;

/** After the area button's visible name and tag: what it does, and where attention waits. */
export const areaButtonTail = (attentionIn?: string): string =>
  attentionIn ? `, change area. Attention in ${attentionIn}` : ', change area';

/** Spoken after a context switch. */
export const nowIn = (name: string): string => `Now in ${name}, Test`;

/** Each attention meta as it reads in its link's name ("Logs, 3 new errors"). */
export const ATTENTION_LABEL = {
  quickstart: (done: number, total: number) => `${done} of ${total} done`,
  errors: (n: number) => `${n} new ${n === 1 ? 'error' : 'errors'}`,
  failedDeliveries: (n: number) => `${n} failed ${n === 1 ? 'delivery' : 'deliveries'}`,
  inboxNew: (n: number) => `${n} new`,
  running: (n: number) => `${n} running`,
  keyExpiring: 'A key expires within 7 days',
} as const;

/** Where a launch link came from, as its chip says it (design §2.4). */
export const ORIGIN_COPY = {
  admin: { back: 'Back to admin', quiet: 'Admin' },
  developers: { back: 'Back to docs', quiet: 'Docs' },
} as const;

/** The shortcuts sheet (design §5.4). */
export const SHORTCUTS = {
  title: 'Keyboard shortcuts',
  groups: [
    {
      heading: 'Go to',
      rows: [
        ['g h', 'Home'],
        ['g q', 'Quickstart'],
        ['g d', 'Design'],
        ['g p', 'Passes'],
        ['g c', 'Console'],
        ['g l', 'Logs'],
        ['g e', 'Events (g w too)'],
        ['g i', 'Inbox'],
        ['g a', 'Activity'],
        ['g k', 'Keys'],
        ['g s', 'Sandbox'],
      ],
    },
    {
      heading: 'Lists',
      rows: [
        ['j / k', 'Next, previous'],
        ['[ / ]', 'Previous, next record'],
        ['Enter', 'Open'],
        ['Esc', 'Close the top layer'],
        ['/', 'Focus the filter'],
      ],
    },
    {
      heading: 'Records',
      rows: [
        ['y', 'Copy id'],
        ['c', 'Copy as curl'],
        ['e', 'Edit in Console'],
        ['r', 'Replay or resend'],
        ['.', 'Simulate menu'],
      ],
    },
    {
      heading: 'Anywhere',
      rows: [
        ['⌘K', 'Search'],
        ['⌘↵', 'Run or send'],
        ['⌘S', 'Save version'],
        ['? or ⌘/', 'This sheet'],
      ],
    },
  ],
  collisions: 'g waits 1.2 s for its second key, so c and g c, or e and g e, never clash.',
} as const;
