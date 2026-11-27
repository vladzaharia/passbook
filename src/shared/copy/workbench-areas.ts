import type { WbTool } from '../workbench.ts';

/** Area names and search words, shared by the Workbench shell and admin's bridge to it. */
export const WB_AREA_WORDS: Record<WbTool, { title: string; keywords: readonly string[] }> = {
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
