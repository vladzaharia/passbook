import { actionLabel } from './actions.ts';

const MODE_NAME: Record<string, string> = { live: 'Live', test: 'Test' };

/**
 * The entry's sentence, naming the mode where the action has one: a release says where it went
 * ("Template version released to Live"). Without a mode in the detail it is the plain label.
 */
export function entryLabel(entry: { action: string; detail: unknown }): string {
  const label = actionLabel(entry.action);
  if (entry.action !== 'template.release' && entry.action !== 'template.rollback') return label;
  const mode = (entry.detail as { mode?: unknown } | null)?.mode;
  const name = typeof mode === 'string' ? MODE_NAME[mode] : undefined;
  return name ? `${label} to ${name}` : label;
}
