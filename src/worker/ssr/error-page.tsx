/**
 * HTML error pages for worker routes a browser opens (never problem+json there). Built on the
 * hosted shell with static art; one h1, one line, one primary action.
 */
import { type HostedArt, hostedPage } from './hosted.ts';
import { escapeHtml } from './theme.ts';

export interface ErrorPageInput {
  status: number;
  nonce: string;
  /** Overrides the status default. */
  title?: string;
  line?: string;
  /** The one action. Retry defaults to the current URL (`href` "" reloads the page). */
  action?: { label: string; href: string };
  /** Seconds from a 429's Retry-After header. */
  retryAfter?: number | null;
}

function waitLine(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 60) return 'Try again in a minute.';
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minutes.`;
}

function defaults(input: ErrorPageInput): { title: string; line?: string; art: HostedArt } {
  if (input.status === 404) return { title: 'Page not found', art: 'lost' };
  if (input.status === 429) {
    return { title: 'Too many requests', line: waitLine(input.retryAfter), art: 'throttled' };
  }
  return { title: 'Something went wrong', art: 'broken' };
}

export function renderErrorPage(input: ErrorPageInput): string {
  const d = defaults(input);
  const action =
    input.action ??
    (input.status === 404 ? { label: 'Go home', href: '/' } : { label: 'Retry', href: '' });
  const line = input.line ?? d.line;
  return hostedPage({
    nonce: input.nonce,
    title: input.title ?? d.title,
    art: d.art,
    ...(line ? { lede: escapeHtml(line) } : {}),
    body: `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
  });
}
