import type { WbTool } from '../workbench.ts';

/** The admin side of the Workbench bridge (design §2.4). The Workbench is Test only. */
export const BRIDGE_COPY = {
  open: 'Open in Workbench',
  /** The sidebar entry; its name says what it opens. */
  entry: 'Workbench',
  entryName: 'Workbench, opens Test',
  test: 'Test',
  opensTest: 'Opens Test',
  back: 'Back to Workbench',
  quiet: 'Workbench',
  group: 'Workbench',
  /** Spoken when admin adopts Test from a launch link. */
  adopted: 'Test mode on.',
} as const;

/**
 * The area names admin shows ("← Events", the palette). The same words as the Workbench's own
 * `WB_AREA`, kept here so admin never loads the shell's copy file; a test holds the two equal.
 */
export const BRIDGE_AREA: Record<WbTool, { title: string; keywords: readonly string[] }> = {
  home: { title: 'Home', keywords: ['overview', 'start'] },
  quickstart: { title: 'Quickstart', keywords: ['start', 'first call'] },
  design: { title: 'Design', keywords: ['templates', 'designer', 'blueprints'] },
  passes: { title: 'Passes', keywords: ['simulate', 'phone', 'devices'] },
  console: { title: 'Console', keywords: ['run', 'request', 'try'] },
  logs: { title: 'Logs', keywords: ['requests', 'calls', 'errors'] },
  events: { title: 'Events', keywords: ['webhooks', 'endpoints', 'deliveries', 'captures'] },
  inbox: { title: 'Test inbox', keywords: ['emails', 'mail'] },
  activity: { title: 'Activity', keywords: ['operations', 'jobs', 'running'] },
  keys: { title: 'Keys', keywords: ['api keys', 'secrets', 'tokens'] },
  sandbox: { title: 'Sandbox', keywords: ['reset', 'limits', 'start over'] },
};
